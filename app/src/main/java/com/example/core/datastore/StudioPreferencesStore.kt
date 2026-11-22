package com.example.core.datastore

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.example.BuildConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.studioDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "autotube_studio_prefs"
)

data class StudioAppSettings(
    val backendApiUrl: String = DEFAULT_BACKEND_URL,
    val supabaseUrl: String = DEFAULT_SUPABASE_URL,
    val supabaseAnonKey: String = DEFAULT_SUPABASE_ANON_KEY,
    val googleWebClientId: String = DEFAULT_GOOGLE_WEB_CLIENT_ID,
    val darkTheme: Boolean = true,
    val appLanguage: String = "en",
    val defaultQuality: String = "1080p",
    val defaultFormat: String = "9:16",
    val notificationsEnabled: Boolean = true,
    val preferredScriptProvider: String = "gemini",
    val preferredResearchProvider: String = "gemini",
    val preferredVoiceProvider: String = "gemini_tts",
    val preferredMediaProviders: String = "pexels,pixabay",
    val lastNotifiedEventId: String = ""
) {
    companion object {
        private const val PROD_BACKEND_URL = "https://auto-studio-xm5k.onrender.com"
        private const val PROD_SUPABASE_URL = "https://etfyzcbjcrnkqvxoxibn.supabase.co"
        // Public client publishable key (safe to ship in mobile apps; protected by Supabase RLS)
        private const val PROD_SUPABASE_PUBLISHABLE_KEY =
            "sb_publishable_xXtBlI675dY79Twmdzr2pQ_EQvpYqHd"
        // Public Google OAuth Web Client ID for Android Credential Manager One-Tap (not a secret)
        private const val PROD_GOOGLE_WEB_CLIENT_ID =
            "684427959696-puv5aaboojuhklk6tpajevmjppakohn5.apps.googleusercontent.com"

        private fun isPlaceholder(value: String?): Boolean {
            if (value.isNullOrBlank()) return true
            val lower = value.lowercase()
            return lower.contains("your-autotube-api") ||
                lower.contains("your-project-ref") ||
                lower.contains("my_supabase_") ||
                lower.contains("my_backend_")
        }

        val DEFAULT_BACKEND_URL: String
            get() = BuildConfig.BACKEND_API_URL.takeUnless { isPlaceholder(it) } ?: PROD_BACKEND_URL
        val DEFAULT_SUPABASE_URL: String
            get() = BuildConfig.SUPABASE_URL.takeUnless { isPlaceholder(it) } ?: PROD_SUPABASE_URL
        val DEFAULT_SUPABASE_ANON_KEY: String
            get() = BuildConfig.SUPABASE_ANON_KEY.takeUnless { isPlaceholder(it) }
                ?: PROD_SUPABASE_PUBLISHABLE_KEY
        val DEFAULT_GOOGLE_WEB_CLIENT_ID: String
            get() = PROD_GOOGLE_WEB_CLIENT_ID
    }
}

class StudioPreferencesStore(private val context: Context) {
    private fun resolveNonPlaceholder(saved: String?, fallback: String): String {
        if (saved.isNullOrBlank()) return fallback
        val lower = saved.lowercase()
        val placeholder = lower.contains("your-autotube-api") ||
            lower.contains("your-project-ref") ||
            lower.contains("my_supabase_") ||
            lower.contains("my_backend_")
        return if (placeholder) fallback else saved
    }

    val settingsFlow: Flow<StudioAppSettings> = context.studioDataStore.data.map { prefs ->
        StudioAppSettings(
            backendApiUrl = resolveNonPlaceholder(
                prefs[KEY_BACKEND_URL],
                StudioAppSettings.DEFAULT_BACKEND_URL
            ),
            supabaseUrl = resolveNonPlaceholder(
                prefs[KEY_SUPABASE_URL],
                StudioAppSettings.DEFAULT_SUPABASE_URL
            ),
            supabaseAnonKey = resolveNonPlaceholder(
                prefs[KEY_SUPABASE_ANON_KEY],
                StudioAppSettings.DEFAULT_SUPABASE_ANON_KEY
            ),
            googleWebClientId = prefs[KEY_GOOGLE_WEB_CLIENT_ID]?.ifBlank {
                StudioAppSettings.DEFAULT_GOOGLE_WEB_CLIENT_ID
            } ?: StudioAppSettings.DEFAULT_GOOGLE_WEB_CLIENT_ID,
            darkTheme = prefs[KEY_DARK_THEME] ?: true,
            appLanguage = prefs[KEY_LANGUAGE] ?: "en",
            defaultQuality = prefs[KEY_QUALITY] ?: "1080p",
            defaultFormat = prefs[KEY_FORMAT] ?: "9:16",
            notificationsEnabled = prefs[KEY_NOTIFICATIONS] ?: true,
            preferredScriptProvider = prefs[KEY_SCRIPT_PROVIDER] ?: "gemini",
            preferredResearchProvider = prefs[KEY_RESEARCH_PROVIDER] ?: "gemini",
            preferredVoiceProvider = prefs[KEY_VOICE_PROVIDER] ?: "gemini_tts",
            preferredMediaProviders = prefs[KEY_MEDIA_PROVIDERS] ?: "pexels,pixabay",
            lastNotifiedEventId = prefs[KEY_LAST_NOTIFIED_ID] ?: ""
        )
    }

    suspend fun currentSettings(): StudioAppSettings = settingsFlow.first()

    suspend fun updateCloudEndpoints(
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String,
        googleWebClientId: String? = null
    ) {
        context.studioDataStore.edit { prefs ->
            prefs[KEY_BACKEND_URL] = backendUrl.trim().trimEnd('/')
            prefs[KEY_SUPABASE_URL] = supabaseUrl.trim().trimEnd('/')
            prefs[KEY_SUPABASE_ANON_KEY] = supabaseAnonKey.trim()
            if (googleWebClientId != null) {
                prefs[KEY_GOOGLE_WEB_CLIENT_ID] = googleWebClientId.trim()
            }
        }
    }

    suspend fun updateAppPreferences(
        darkTheme: Boolean? = null,
        language: String? = null,
        defaultQuality: String? = null,
        defaultFormat: String? = null,
        notificationsEnabled: Boolean? = null
    ) {
        context.studioDataStore.edit { prefs ->
            darkTheme?.let { prefs[KEY_DARK_THEME] = it }
            language?.let { prefs[KEY_LANGUAGE] = it }
            defaultQuality?.let { prefs[KEY_QUALITY] = it }
            defaultFormat?.let { prefs[KEY_FORMAT] = it }
            notificationsEnabled?.let { prefs[KEY_NOTIFICATIONS] = it }
        }
    }

    suspend fun updateProviderRouting(
        scriptProvider: String,
        researchProvider: String,
        voiceProvider: String,
        mediaProviders: String
    ) {
        context.studioDataStore.edit { prefs ->
            prefs[KEY_SCRIPT_PROVIDER] = scriptProvider
            prefs[KEY_RESEARCH_PROVIDER] = researchProvider
            prefs[KEY_VOICE_PROVIDER] = voiceProvider
            prefs[KEY_MEDIA_PROVIDERS] = mediaProviders
        }
    }

    suspend fun setLastNotifiedEventId(id: String) {
        context.studioDataStore.edit { prefs ->
            prefs[KEY_LAST_NOTIFIED_ID] = id
        }
    }

    companion object {
        private val KEY_BACKEND_URL = stringPreferencesKey("backend_api_url")
        private val KEY_SUPABASE_URL = stringPreferencesKey("supabase_url")
        private val KEY_SUPABASE_ANON_KEY = stringPreferencesKey("supabase_anon_key")
        private val KEY_GOOGLE_WEB_CLIENT_ID = stringPreferencesKey("google_web_client_id")
        private val KEY_DARK_THEME = booleanPreferencesKey("dark_theme")
        private val KEY_LANGUAGE = stringPreferencesKey("app_language")
        private val KEY_QUALITY = stringPreferencesKey("default_quality")
        private val KEY_FORMAT = stringPreferencesKey("default_format")
        private val KEY_NOTIFICATIONS = booleanPreferencesKey("notifications_enabled")
        private val KEY_SCRIPT_PROVIDER = stringPreferencesKey("pref_script_provider")
        private val KEY_RESEARCH_PROVIDER = stringPreferencesKey("pref_research_provider")
        private val KEY_VOICE_PROVIDER = stringPreferencesKey("pref_voice_provider")
        private val KEY_MEDIA_PROVIDERS = stringPreferencesKey("pref_media_providers")
        private val KEY_LAST_NOTIFIED_ID = stringPreferencesKey("last_notified_event_id")
    }
}
