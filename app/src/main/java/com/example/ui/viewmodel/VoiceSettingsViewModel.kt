package com.example.ui.viewmodel

import android.app.Application
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Base64
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.example.core.network.VoicePreviewRequest
import com.example.data.StudioRepository
import com.example.ui.components.STUDIO_VOICE_OPTIONS
import com.example.ui.components.StudioVoiceOption
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

data class VoiceSettingsUiState(
    val voices: List<StudioVoiceOption> = STUDIO_VOICE_OPTIONS,
    val isLoadingVoices: Boolean = false,
    val selectedVoiceId: String = "Charon",
    val selectedProvider: String = "gemini_tts",
    val voiceSpeed: Double = 1.0,
    val previewLanguage: String = "hi",
    val customSampleText: String = "",
    val genderFilter: String = "all",
    val searchQuery: String = "",
    val previewingVoiceId: String? = null,
    val playingVoiceId: String? = null,
    val lastPreviewProviderUsed: String? = null,
    val previewError: String? = null,
    val statusMessage: String? = null
) {
    val selectedVoice: StudioVoiceOption
        get() = voices.firstOrNull { it.id.equals(selectedVoiceId, ignoreCase = true) }
            ?: voices.firstOrNull()
            ?: STUDIO_VOICE_OPTIONS.first()

    val filteredVoices: List<StudioVoiceOption>
        get() {
            val q = searchQuery.trim().lowercase()
            return voices.filter { v ->
                val genderOk = genderFilter == "all" || v.gender.equals(genderFilter, ignoreCase = true)
                val queryOk = q.isBlank() ||
                    v.displayName.lowercase().contains(q) ||
                    v.tone.lowercase().contains(q) ||
                    v.badge.lowercase().contains(q)
                genderOk && queryOk
            }
        }
}

class VoiceSettingsViewModel(
    private val application: Application,
    private val repository: StudioRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(VoiceSettingsUiState())
    val uiState: StateFlow<VoiceSettingsUiState> = _uiState.asStateFlow()

    private var mediaPlayer: MediaPlayer? = null

    init {
        // Hydrate persisted voice selection & provider from DataStore
        viewModelScope.launch {
            repository.appSettings.collect { settings ->
                _uiState.update { state ->
                    state.copy(
                        selectedProvider = settings.preferredVoiceProvider,
                        selectedVoiceId = settings.preferredVoiceId.ifBlank { "Charon" },
                        voiceSpeed = settings.preferredVoiceSpeed,
                        previewLanguage = if (state.previewLanguage.isBlank()) settings.appLanguage else state.previewLanguage
                    )
                }
            }
        }

        // Refresh full 30-voice catalog from backend whenever user is authenticated
        viewModelScope.launch {
            repository.authSession.collect { session ->
                if (session != null) {
                    loadVoicesCatalog()
                }
            }
        }
    }

    fun loadVoicesCatalog() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingVoices = true) }
            repository.getVoicesCatalog()
                .onSuccess { remoteList ->
                    if (remoteList.isNotEmpty()) {
                        val mapped = remoteList.map { dto ->
                            val cleanGender = if (dto.gender.equals("female", ignoreCase = true)) "female" else "male"
                            StudioVoiceOption(
                                id = dto.id,
                                displayName = dto.displayName.ifBlank { dto.id },
                                gender = cleanGender,
                                tone = dto.tone.ifBlank { dto.style.ifBlank { "Studio Voice" } },
                                badge = if (cleanGender == "female") "Female" else "Male"
                            )
                        }
                        _uiState.update { it.copy(voices = mapped, isLoadingVoices = false) }
                    } else {
                        _uiState.update { it.copy(isLoadingVoices = false) }
                    }
                }
                .onFailure {
                    // Keep built-in 30-voice local catalog so the screen remains fully usable offline
                    _uiState.update { it.copy(isLoadingVoices = false) }
                }
        }
    }

    fun selectVoice(voiceId: String) {
        val current = _uiState.value
        _uiState.update {
            it.copy(
                selectedVoiceId = voiceId,
                statusMessage = "Default voice set to $voiceId for video generation",
                previewError = null
            )
        }
        viewModelScope.launch {
            repository.updateVoiceDefaults(
                voiceProvider = current.selectedProvider,
                voiceId = voiceId,
                voiceSpeed = current.voiceSpeed
            )
        }
    }

    fun setVoiceProvider(provider: String) {
        val current = _uiState.value
        _uiState.update { it.copy(selectedProvider = provider, previewError = null) }
        viewModelScope.launch {
            repository.updateVoiceDefaults(
                voiceProvider = provider,
                voiceId = current.selectedVoiceId,
                voiceSpeed = current.voiceSpeed
            )
        }
    }

    fun setVoiceSpeed(speed: Double) {
        val clamped = speed.coerceIn(0.75, 1.4)
        val current = _uiState.value
        _uiState.update { it.copy(voiceSpeed = clamped, previewError = null) }
        viewModelScope.launch {
            repository.updateVoiceDefaults(
                voiceProvider = current.selectedProvider,
                voiceId = current.selectedVoiceId,
                voiceSpeed = clamped
            )
        }
    }

    fun setPreviewLanguage(language: String) {
        _uiState.update { it.copy(previewLanguage = language, previewError = null) }
    }

    fun setCustomSampleText(text: String) {
        _uiState.update { it.copy(customSampleText = text.take(180)) }
    }

    fun setGenderFilter(filter: String) {
        _uiState.update { it.copy(genderFilter = filter) }
    }

    fun setSearchQuery(query: String) {
        _uiState.update { it.copy(searchQuery = query) }
    }

    fun dismissFeedback() {
        _uiState.update { it.copy(previewError = null, statusMessage = null) }
    }

    /**
     * Requests a real live audio sample for any of the 30 AI voices from the backend
     * (caching decoded audio in app cacheDir for instant replay) and plays it cleanly via MediaPlayer.
     */
    fun previewVoice(
        voiceId: String,
        providerOverride: String? = null,
        languageOverride: String? = null,
        speedOverride: Double? = null,
        sampleTextOverride: String? = null
    ) {
        val current = _uiState.value
        // Tapping the currently playing voice stops playback
        if (current.playingVoiceId.equals(voiceId, ignoreCase = true) && current.previewingVoiceId == null) {
            stopPreview()
            return
        }

        stopPreview()

        val effectiveProvider = providerOverride ?: current.selectedProvider
        val effectiveLanguage = languageOverride ?: current.previewLanguage
        val effectiveSpeed = (speedOverride ?: current.voiceSpeed).coerceIn(0.75, 1.4)
        val effectiveSample = (sampleTextOverride ?: current.customSampleText).trim().takeIf { it.isNotBlank() }

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    previewingVoiceId = voiceId,
                    playingVoiceId = null,
                    previewError = null
                )
            }

            val cacheFile = buildLocalPreviewFile(
                voiceId = voiceId,
                provider = effectiveProvider,
                language = effectiveLanguage,
                speed = effectiveSpeed,
                sampleText = effectiveSample
            )

            // Instant replay from local disk cache if already auditioned recently
            if (cacheFile.exists() && cacheFile.length() > 1024L) {
                playLocalAudioFile(voiceId = voiceId, file = cacheFile, providerUsed = effectiveProvider)
                return@launch
            }

            repository.previewVoice(
                VoicePreviewRequest(
                    voiceId = voiceId,
                    provider = effectiveProvider,
                    language = effectiveLanguage,
                    speed = effectiveSpeed,
                    sampleText = effectiveSample
                )
            ).onSuccess { resp ->
                if (resp.audioBase64.isBlank()) {
                    _uiState.update {
                        it.copy(
                            previewingVoiceId = null,
                            previewError = "Backend returned empty audio preview for $voiceId."
                        )
                    }
                    return@onSuccess
                }

                val writtenFile = withContext(Dispatchers.IO) {
                    val bytes = Base64.decode(resp.audioBase64, Base64.DEFAULT)
                    val ext = if (resp.mimeType.contains("mpeg", ignoreCase = true) ||
                        resp.mimeType.contains("mp3", ignoreCase = true)
                    ) "mp3" else "wav"
                    val outFile = File(cacheFile.parentFile, "${cacheFile.nameWithoutExtension}.$ext")
                    outFile.writeBytes(bytes)
                    outFile
                }

                playLocalAudioFile(
                    voiceId = voiceId,
                    file = writtenFile,
                    providerUsed = resp.providerUsed
                )
            }.onFailure { err ->
                _uiState.update {
                    it.copy(
                        previewingVoiceId = null,
                        playingVoiceId = null,
                        previewError = err.message ?: "Voice preview failed. Connect your Gemini or ElevenLabs API key in Settings."
                    )
                }
            }
        }
    }

    private fun buildLocalPreviewFile(
        voiceId: String,
        provider: String,
        language: String,
        speed: Double,
        sampleText: String?
    ): File {
        val dir = File(application.cacheDir, "voice_previews").apply { mkdirs() }
        val keyHash = "${voiceId}_${provider}_${language}_${"%.2f".format(speed)}_${sampleText.orEmpty()}".hashCode()
        val baseName = "vp_${voiceId.lowercase()}_${Integer.toHexString(keyHash)}"
        val wavFile = File(dir, "$baseName.wav")
        if (wavFile.exists()) return wavFile
        val mp3File = File(dir, "$baseName.mp3")
        if (mp3File.exists()) return mp3File
        return wavFile
    }

    private fun playLocalAudioFile(voiceId: String, file: File, providerUsed: String) {
        releasePlayer()
        runCatching {
            val player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                setDataSource(file.absolutePath)
                setOnCompletionListener {
                    releasePlayer()
                    _uiState.update { it.copy(playingVoiceId = null) }
                }
                setOnErrorListener { _, _, _ ->
                    releasePlayer()
                    _uiState.update {
                        it.copy(
                            playingVoiceId = null,
                            previewError = "Audio playback error for $voiceId."
                        )
                    }
                    true
                }
                prepare()
                start()
            }
            mediaPlayer = player
            _uiState.update {
                it.copy(
                    previewingVoiceId = null,
                    playingVoiceId = voiceId,
                    lastPreviewProviderUsed = providerUsed,
                    previewError = null
                )
            }
        }.onFailure { err ->
            releasePlayer()
            _uiState.update {
                it.copy(
                    previewingVoiceId = null,
                    playingVoiceId = null,
                    previewError = "Could not play audio preview: ${err.localizedMessage ?: "playback failed"}"
                )
            }
        }
    }

    fun stopPreview() {
        releasePlayer()
        _uiState.update { it.copy(playingVoiceId = null, previewingVoiceId = null) }
    }

    private fun releasePlayer() {
        runCatching {
            mediaPlayer?.apply {
                if (isPlaying) stop()
                reset()
                release()
            }
        }
        mediaPlayer = null
    }

    override fun onCleared() {
        releasePlayer()
        super.onCleared()
    }

    class Factory(
        private val application: Application,
        private val repository: StudioRepository
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return VoiceSettingsViewModel(application, repository) as T
        }
    }
}
