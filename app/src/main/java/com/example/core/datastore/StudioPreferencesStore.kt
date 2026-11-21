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
        val DEFAULT_BACKEND_URL: String
            get() = BuildConfig.BACKEND_API_URL.ifBlank { "https://your-autotube-api.onrender.com" }
        val DEFAULT_SUPABASE_URL: String
            get() = BuildConfig.SUPABASE_URL.ifBlank { "https://your-project-ref.supabase.co" }
        val DEFAULT_SUPABASE_ANON_KEY: String
            get() = BuildConfig.SUPABASE_ANON_KEY
    }
}

class StudioPreferencesStore(private val context: Context) {
    val settingsFlow: Flow<StudioAppSettings> = context.studioDataStore.data.map { prefs ->
        StudioAppSettings(
            backendApiUrl = prefs[KEY_BACKEND_URL]?.ifBlank { StudioAppSettings.DEFAULT_BACKEND_URL }
                ?: StudioAppSettings.DEFAULT_BACKEND_URL,
            supabaseUrl = prefs[KEY_SUPABASE_URL]?.ifBlank { StudioAppSettings.DEFAULT_SUPABASE_URL }
                ?: StudioAppSettings.DEFAULT_SUPABASE_URL,
            supabaseAnonKey = prefs[KEY_SUPABASE_ANON_KEY]
                ?: StudioAppSettings.DEFAULT_SUPABASE_ANON_KEY,
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
        supabaseAnonKey: String
    ) {
        context.studioDataStore.edit { prefs ->
            prefs[KEY_BACKEND_URL] = backendUrl.trim().trimEnd('/')
            prefs[KEY_SUPABASE_URL] = supabaseUrl.trim().trimEnd('/')
            prefs[KEY_SUPABASE_ANON_KEY] = supabaseAnonKey.trim()
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
