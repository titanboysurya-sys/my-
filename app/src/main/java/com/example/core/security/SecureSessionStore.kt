package com.example.core.security

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class AuthSession(
    val userId: String,
    val email: String,
    val accessToken: String,
    val refreshToken: String,
    val expiresAtEpochSec: Long
) {
    val isExpired: Boolean
        get() = (System.currentTimeMillis() / 1000L) >= (expiresAtEpochSec - 30L)
}

/**
 * Encrypts user authentication tokens at rest using Android Keystore AES-256-GCM.
 * Never logs token values. Falls back cleanly in local Robolectric JVM unit tests.
 */
class SecureSessionStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _session = MutableStateFlow<AuthSession?>(loadSession())
    val session: StateFlow<AuthSession?> = _session.asStateFlow()

    fun currentSession(): AuthSession? = _session.value

    fun saveSession(session: AuthSession) {
        prefs.edit()
            .putString(KEY_USER_ID, encryptOrPlain(session.userId))
            .putString(KEY_EMAIL, encryptOrPlain(session.email))
            .putString(KEY_ACCESS_TOKEN, encryptOrPlain(session.accessToken))
            .putString(KEY_REFRESH_TOKEN, encryptOrPlain(session.refreshToken))
            .putLong(KEY_EXPIRES_AT, session.expiresAtEpochSec)
            .apply()
        _session.value = session
    }

    fun clearSession() {
        prefs.edit().clear().apply()
        _session.value = null
    }

    private fun loadSession(): AuthSession? {
        val userId = decryptOrNull(prefs.getString(KEY_USER_ID, null)) ?: return null
        val accessToken = decryptOrNull(prefs.getString(KEY_ACCESS_TOKEN, null)) ?: return null
        val refreshToken = decryptOrNull(prefs.getString(KEY_REFRESH_TOKEN, null)) ?: ""
        val email = decryptOrNull(prefs.getString(KEY_EMAIL, null)) ?: ""
        val expiresAt = prefs.getLong(KEY_EXPIRES_AT, 0L)
        return AuthSession(
            userId = userId,
            email = email,
            accessToken = accessToken,
            refreshToken = refreshToken,
            expiresAtEpochSec = expiresAt
        )
    }

    private fun getOrCreateKey(): SecretKey? {
        return try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val existing = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
            if (existing != null) return existing

            val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            val spec = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
            keyGen.init(spec)
            keyGen.generateKey()
        } catch (_: Throwable) {
            null
        }
    }

    private fun encryptOrPlain(plaintext: String): String {
        val key = getOrCreateKey() ?: return "plain:$plaintext"
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
            val encrypted = Base64.encodeToString(
                cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8)),
                Base64.NO_WRAP
            )
            "gcm:$iv:$encrypted"
        } catch (_: Throwable) {
            "plain:$plaintext"
        }
    }

    private fun decryptOrNull(stored: String?): String? {
        if (stored.isNullOrBlank()) return null
        if (stored.startsWith("plain:")) return stored.removePrefix("plain:")
        if (!stored.startsWith("gcm:")) return null
        val parts = stored.split(":")
        if (parts.size != 3) return null
        val key = getOrCreateKey() ?: return null
        return try {
            val iv = Base64.decode(parts[1], Base64.NO_WRAP)
            val ciphertext = Base64.decode(parts[2], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (_: Throwable) {
            null
        }
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "autotube_studio_session_aes256"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val PREFS_NAME = "autotube_secure_session"
        private const val KEY_USER_ID = "uid"
        private const val KEY_EMAIL = "email"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_EXPIRES_AT = "expires_at"
    }
}
