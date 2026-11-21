package com.example.core.network

import com.example.core.datastore.StudioPreferencesStore
import com.example.core.security.AuthSession
import com.example.core.security.SecureSessionStore
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Provides runtime-configurable Retrofit clients for both the Render Backend API
 * and Supabase Auth REST API, automatically injecting Bearer JWTs and refreshing expired sessions.
 */
class DynamicBackendClient(
    private val prefsStore: StudioPreferencesStore,
    private val sessionStore: SecureSessionStore
) {
    private val moshi: Moshi = Moshi.Builder()
        .addLast(KotlinJsonAdapterFactory())
        .build()

    private val safeLoggingInterceptor = HttpLoggingInterceptor().apply {
        // BASIC level never prints request/response bodies or API keys in logs
        level = HttpLoggingInterceptor.Level.BASIC
        redactHeader("Authorization")
        redactHeader("apikey")
    }

    private val authInterceptor = Interceptor { chain ->
        val original = chain.request()
        val session = sessionStore.currentSession()
        val builder = original.newBuilder()
            .header("Accept", "application/json")

        if (session != null && session.accessToken.isNotBlank()) {
            val activeToken = if (session.isExpired && session.refreshToken.isNotBlank()) {
                runBlocking { tryRefreshToken(session) } ?: session.accessToken
            } else {
                session.accessToken
            }
            builder.header("Authorization", "Bearer $activeToken")
        }

        chain.proceed(builder.build())
    }

    private val backendOkHttp: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .addInterceptor(authInterceptor)
        .addInterceptor(safeLoggingInterceptor)
        .build()

    private val authOkHttp: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(safeLoggingInterceptor)
        .build()

    @Volatile
    private var cachedBackendUrl: String? = null

    @Volatile
    private var cachedBackendApi: AutoTubeBackendApi? = null

    @Volatile
    private var cachedSupabaseUrl: String? = null

    @Volatile
    private var cachedSupabaseAuthApi: SupabaseAuthApi? = null

    suspend fun backendApi(overrideBaseUrl: String? = null): AutoTubeBackendApi {
        val raw = (overrideBaseUrl ?: prefsStore.currentSettings().backendApiUrl).trim()
        val normalized = normalizeBaseUrl(raw)
        val existing = cachedBackendApi
        if (existing != null && cachedBackendUrl == normalized) {
            return existing
        }
        val created = Retrofit.Builder()
            .baseUrl(normalized)
            .client(backendOkHttp)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
            .create(AutoTubeBackendApi::class.java)
        cachedBackendUrl = normalized
        cachedBackendApi = created
        return created
    }

    suspend fun supabaseAuthApi(overrideSupabaseUrl: String? = null): SupabaseAuthApi {
        val raw = (overrideSupabaseUrl ?: prefsStore.currentSettings().supabaseUrl).trim()
        val normalized = normalizeBaseUrl(raw)
        val existing = cachedSupabaseAuthApi
        if (existing != null && cachedSupabaseUrl == normalized) {
            return existing
        }
        val created = Retrofit.Builder()
            .baseUrl(normalized)
            .client(authOkHttp)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
            .create(SupabaseAuthApi::class.java)
        cachedSupabaseUrl = normalized
        cachedSupabaseAuthApi = created
        return created
    }

    private suspend fun tryRefreshToken(session: AuthSession): String? {
        return try {
            val settings = prefsStore.currentSettings()
            if (settings.supabaseAnonKey.isBlank()) return null
            val response = supabaseAuthApi(settings.supabaseUrl).refreshSession(
                anonKey = settings.supabaseAnonKey,
                body = SupabaseRefreshRequest(session.refreshToken)
            )
            val newAccess = response.accessToken ?: return null
            val updated = session.copy(
                accessToken = newAccess,
                refreshToken = response.refreshToken ?: session.refreshToken,
                expiresAtEpochSec = (System.currentTimeMillis() / 1000L) + (response.expiresIn ?: 3600L)
            )
            sessionStore.saveSession(updated)
            newAccess
        } catch (_: Throwable) {
            null
        }
    }

    companion object {
        fun normalizeBaseUrl(raw: String): String {
            val trimmed = raw.trim().trimEnd('/')
            val withScheme = if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
                trimmed
            } else {
                "https://$trimmed"
            }
            return "$withScheme/"
        }
    }
}
