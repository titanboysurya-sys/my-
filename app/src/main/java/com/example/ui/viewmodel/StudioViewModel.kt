package com.example.ui.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.net.URLDecoder
import com.example.core.database.CachedCredentialEntity
import com.example.core.database.CachedJobEntity
import com.example.core.database.CachedNotificationEntity
import com.example.core.database.CachedProjectEntity
import com.example.core.database.CachedYouTubeChannelEntity
import com.example.core.datastore.StudioAppSettings
import com.example.core.network.CreateProjectRequest
import com.example.core.network.DashboardStatsDto
import com.example.core.network.HealthResponse
import com.example.core.network.ProjectDetailResponse
import com.example.core.network.PublishProjectRequest
import com.example.core.network.RerenderProjectRequest
import com.example.core.network.ScheduleDto
import com.example.core.network.TopicResearchRequest
import com.example.core.network.TopicSuggestionDto
import com.example.core.network.UpdateProjectSettingsRequest
import com.example.core.network.UpdateScheduleRequest
import com.example.core.security.AuthSession
import com.example.data.StudioRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class StudioUiState(
    val isLoading: Boolean = false,
    val bannerMessage: String? = null,
    val isErrorBanner: Boolean = false,
    val healthCheckResult: HealthResponse? = null,
    val dashboardStats: DashboardStatsDto = DashboardStatsDto(),
    val automationEnabled: Boolean = false,
    val nextScheduledRun: String? = null,
    val schedule: ScheduleDto? = null,
    val topicSuggestions: List<TopicSuggestionDto> = emptyList(),
    val isResearchingTopics: Boolean = false,
    val selectedProjectDetail: ProjectDetailResponse? = null,
    val isLoadingProjectDetail: Boolean = false,
    val validatingProvider: String? = null,
    val pendingOAuthUrl: String? = null,
    val lastCreatedJobId: String? = null
)

class StudioViewModel(
    private val repository: StudioRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(StudioUiState())
    val uiState: StateFlow<StudioUiState> = _uiState.asStateFlow()

    val authSession: StateFlow<AuthSession?> = repository.authSession

    val appSettings: StateFlow<StudioAppSettings> = repository.appSettings
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), StudioAppSettings())

    val projects: StateFlow<List<CachedProjectEntity>> = repository.projectsFlow
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val jobs: StateFlow<List<CachedJobEntity>> = repository.jobsFlow
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val credentials: StateFlow<List<CachedCredentialEntity>> = repository.credentialsFlow
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val youtubeChannels: StateFlow<List<CachedYouTubeChannelEntity>> = repository.youtubeChannelsFlow
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val notifications: StateFlow<List<CachedNotificationEntity>> = repository.notificationsFlow
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    init {
        viewModelScope.launch {
            authSession.collect { session ->
                if (session != null) {
                    refreshAllStudioData()
                }
            }
        }
    }

    fun observeJob(jobId: String) = repository.observeJobById(jobId)

    fun dismissBanner() {
        _uiState.update { it.copy(bannerMessage = null, isErrorBanner = false) }
    }

    fun consumePendingOAuthUrl() {
        _uiState.update { it.copy(pendingOAuthUrl = null) }
    }

    fun consumeLastCreatedJobId() {
        _uiState.update { it.copy(lastCreatedJobId = null) }
    }

    fun handleYouTubeOAuthDeepLink(status: String?, channel: String?, message: String?) {
        if (status == "connected") {
            showInfo("YouTube channel connected: ${channel ?: "Success"}")
            refreshYouTubeAccounts()
            refreshDashboard()
        } else {
            showError("YouTube connection failed: ${message ?: "Authorization cancelled"}")
        }
    }

    fun handleSupabaseOAuthDeepLink(uri: Uri) {
        val params = mutableMapOf<String, String>()
        uri.queryParameterNames.forEach { key ->
            uri.getQueryParameter(key)?.let { params[key] = it }
        }
        val fragment = uri.fragment.orEmpty()
        if (fragment.isNotBlank()) {
            fragment.split("&").forEach { pair ->
                val idx = pair.indexOf('=')
                if (idx > 0) {
                    val key = URLDecoder.decode(pair.substring(0, idx), "UTF-8")
                    val value = URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
                    params[key] = value
                }
            }
        }

        val errorDesc = params["error_description"] ?: params["error"]
        if (!errorDesc.isNullOrBlank()) {
            showError("Google Sign-In failed: $errorDesc")
            return
        }

        val accessToken = params["access_token"]
        if (accessToken.isNullOrBlank()) {
            showError("Google Sign-In did not return a session token. Verify Supabase Redirect URL includes autotubestudio://oauth/supabase.")
            return
        }

        val refreshToken = params["refresh_token"].orEmpty()
        val expiresIn = params["expires_in"]?.toLongOrNull() ?: 3600L
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.completeSupabaseOAuthSession(accessToken, refreshToken, expiresIn)
                .onSuccess {
                    _uiState.update { it.copy(isLoading = false) }
                    showInfo("Signed in with Google")
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Could not complete Google Sign-In")
                }
        }
    }

    fun signInWithGoogleIdToken(
        idToken: String,
        nonce: String?,
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String,
        googleWebClientId: String
    ) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.signInWithGoogleIdToken(
                idToken = idToken,
                nonce = nonce,
                backendUrl = backendUrl,
                supabaseUrl = supabaseUrl,
                supabaseAnonKey = supabaseAnonKey,
                googleWebClientId = googleWebClientId
            ).onSuccess {
                _uiState.update { it.copy(isLoading = false) }
                showInfo("Signed in with Google One-Tap")
            }.onFailure { err ->
                _uiState.update { it.copy(isLoading = false) }
                showError(err.message ?: "Google One-Tap sign-in failed")
            }
        }
    }

    fun launchSupabaseGoogleOAuth(
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String,
        googleWebClientId: String
    ) {
        viewModelScope.launch {
            repository.buildSupabaseGoogleOAuthUrl(
                backendUrl = backendUrl,
                supabaseUrl = supabaseUrl,
                supabaseAnonKey = supabaseAnonKey,
                googleWebClientId = googleWebClientId
            ).onSuccess { url ->
                _uiState.update { it.copy(pendingOAuthUrl = url) }
            }.onFailure { err ->
                showError(err.message ?: "Could not launch Google Sign-In")
            }
        }
    }

    fun checkServerHealth(overrideUrl: String? = null) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.checkBackendHealth(overrideUrl)
                .onSuccess { health ->
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            healthCheckResult = health,
                            bannerMessage = "Backend reachable (${health.service}) • Supabase: ${if (health.supabaseConfigured) "Ready" else "Pending"}",
                            isErrorBanner = false
                        )
                    }
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Health check failed")
                }
        }
    }

    fun signIn(
        email: String,
        password: String,
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String
    ) {
        if (email.isBlank() || password.length < 6) {
            showError("Enter a valid email and password (min 6 characters).")
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.signIn(email, password, backendUrl, supabaseUrl, supabaseAnonKey)
                .onSuccess {
                    _uiState.update { it.copy(isLoading = false) }
                    showInfo("Signed in to AutoTube Studio")
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Sign in failed")
                }
        }
    }

    fun signUp(
        email: String,
        password: String,
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String
    ) {
        if (email.isBlank() || password.length < 6) {
            showError("Enter a valid email and password (min 6 characters).")
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.signUp(email, password, backendUrl, supabaseUrl, supabaseAnonKey)
                .onSuccess { msg ->
                    _uiState.update { it.copy(isLoading = false) }
                    showInfo(msg)
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Account creation failed")
                }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            repository.signOut()
            showInfo("Signed out cleanly")
        }
    }

    fun deleteAccount() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.deleteAccountAndData()
                .onSuccess {
                    _uiState.update { it.copy(isLoading = false) }
                    showInfo("Account and all cloud data permanently deleted")
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Could not delete account")
                }
        }
    }

    fun saveCloudEndpoints(backendUrl: String, supabaseUrl: String, supabaseAnonKey: String) {
        viewModelScope.launch {
            repository.saveCloudEndpoints(backendUrl, supabaseUrl, supabaseAnonKey)
            showInfo("Cloud server settings saved")
        }
    }

    fun updateAppPreferences(
        darkTheme: Boolean? = null,
        language: String? = null,
        defaultQuality: String? = null,
        defaultFormat: String? = null,
        notificationsEnabled: Boolean? = null
    ) {
        viewModelScope.launch {
            repository.updateAppPreferences(
                darkTheme = darkTheme,
                language = language,
                defaultQuality = defaultQuality,
                defaultFormat = defaultFormat,
                notificationsEnabled = notificationsEnabled
            )
        }
    }

    fun updateProviderRouting(
        scriptProvider: String,
        researchProvider: String,
        voiceProvider: String,
        mediaProviders: String
    ) {
        viewModelScope.launch {
            repository.updateProviderRouting(
                scriptProvider,
                researchProvider,
                voiceProvider,
                mediaProviders
            ).onSuccess {
                showInfo("Preferred provider routing synced to cloud")
            }.onFailure { err ->
                showInfo("Saved locally (cloud sync pending: ${err.message ?: "offline"})")
            }
        }
    }

    fun clearLocalCache() {
        viewModelScope.launch {
            repository.clearLocalCache()
            showInfo("Local Room cache cleared")
        }
    }

    fun refreshAllStudioData() {
        refreshDashboard()
        refreshProjects()
        refreshJobs()
        refreshCredentials()
        refreshYouTubeAccounts()
        loadAutomationSettings()
    }

    fun refreshDashboard() {
        viewModelScope.launch {
            repository.refreshDashboard()
                .onSuccess { resp ->
                    _uiState.update {
                        it.copy(
                            dashboardStats = resp.stats,
                            automationEnabled = resp.automationEnabled,
                            nextScheduledRun = resp.nextScheduledRun
                        )
                    }
                }
        }
    }

    fun refreshProjects() {
        viewModelScope.launch {
            repository.refreshProjects()
        }
    }

    fun refreshJobs() {
        viewModelScope.launch {
            repository.refreshJobs()
        }
    }

    fun refreshJobDetail(jobId: String) {
        viewModelScope.launch {
            repository.refreshJobDetail(jobId)
                .onFailure { showError(it.message ?: "Failed to refresh job status") }
        }
    }

    fun retryJob(jobId: String) {
        viewModelScope.launch {
            repository.retryJob(jobId)
                .onSuccess { showInfo("Job queued for resume from last incomplete stage") }
                .onFailure { showError(it.message ?: "Failed to retry job") }
        }
    }

    fun cancelJob(jobId: String) {
        viewModelScope.launch {
            repository.cancelJob(jobId)
                .onSuccess { showInfo("Job cancelled") }
                .onFailure { showError(it.message ?: "Failed to cancel job") }
        }
    }

    fun researchTopics(request: TopicResearchRequest) {
        viewModelScope.launch {
            _uiState.update { it.copy(isResearchingTopics = true) }
            repository.researchTopics(request)
                .onSuccess { resp ->
                    _uiState.update {
                        it.copy(
                            isResearchingTopics = false,
                            topicSuggestions = resp.suggestions
                        )
                    }
                    if (resp.suggestions.isEmpty()) {
                        showInfo("No topics returned — try a broader niche or check your Groq/Gemini API key.")
                    }
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isResearchingTopics = false) }
                    showError(err.message ?: "Topic research failed")
                }
        }
    }

    fun createProjectAndGenerate(request: CreateProjectRequest) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.createProjectAndStart(request)
                .onSuccess { resp ->
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            lastCreatedJobId = resp.job?.id
                        )
                    }
                    showInfo("Cloud video pipeline started for \"${resp.project.title}\"")
                    refreshDashboard()
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Failed to start video generation")
                }
        }
    }

    fun loadProjectDetail(projectId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingProjectDetail = true) }
            repository.getProjectDetail(projectId)
                .onSuccess { detail ->
                    _uiState.update {
                        it.copy(isLoadingProjectDetail = false, selectedProjectDetail = detail)
                    }
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoadingProjectDetail = false) }
                    showError(err.message ?: "Could not load project details")
                }
        }
    }

    fun saveProjectScript(
        projectId: String,
        narrationText: String,
        titleIdea: String?,
        approveAndContinue: Boolean
    ) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.updateProjectScript(projectId, narrationText, titleIdea, approveAndContinue)
                .onSuccess {
                    _uiState.update { it.copy(isLoading = false) }
                    showInfo(
                        if (approveAndContinue) "Script approved — cloud rendering resumed!"
                        else "Script saved"
                    )
                    loadProjectDetail(projectId)
                    refreshJobs()
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Failed to save script")
                }
        }
    }

    fun regenerateProjectScript(projectId: String, tone: String, durationSeconds: Int) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.regenerateProjectScript(projectId, tone, durationSeconds)
                .onSuccess {
                    _uiState.update { it.copy(isLoading = false) }
                    showInfo("Regenerated fresh script version")
                    loadProjectDetail(projectId)
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Script regeneration failed")
                }
        }
    }

    fun saveProjectSettingsAndRerender(
        projectId: String,
        settingsRequest: UpdateProjectSettingsRequest,
        rerenderRequest: RerenderProjectRequest?
    ) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            val saveRes = repository.updateProjectSettings(projectId, settingsRequest)
            saveRes.onFailure { err ->
                _uiState.update { it.copy(isLoading = false) }
                showError(err.message ?: "Failed to save project settings")
                return@launch
            }
            if (rerenderRequest != null) {
                repository.rerenderProject(projectId, rerenderRequest)
                    .onSuccess { job ->
                        _uiState.update {
                            it.copy(isLoading = false, lastCreatedJobId = job.id)
                        }
                        showInfo("Saved changes — re-rendering video with your updated voice, subtitles & media!")
                        loadProjectDetail(projectId)
                        refreshProjects()
                        refreshJobs()
                    }
                    .onFailure { err ->
                        _uiState.update { it.copy(isLoading = false) }
                        showError(err.message ?: "Settings saved, but re-render failed to queue")
                    }
            } else {
                _uiState.update { it.copy(isLoading = false) }
                showInfo("Project settings & media links saved")
                loadProjectDetail(projectId)
                refreshProjects()
            }
        }
    }

    fun publishProjectToYouTube(
        projectId: String,
        request: PublishProjectRequest
    ) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.publishProject(projectId, request)
                .onSuccess { job ->
                    _uiState.update {
                        it.copy(isLoading = false, lastCreatedJobId = job.id)
                    }
                    showInfo("Approved! Uploading rendered MP4 directly to YouTube...")
                    loadProjectDetail(projectId)
                    refreshProjects()
                    refreshJobs()
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Could not start YouTube upload")
                }
        }
    }

    fun deleteProject(projectId: String) {
        viewModelScope.launch {
            repository.deleteProject(projectId)
                .onSuccess {
                    _uiState.update { it.copy(selectedProjectDetail = null) }
                    showInfo("Project deleted")
                    refreshProjects()
                }
                .onFailure { showError(it.message ?: "Delete failed") }
        }
    }

    fun refreshCredentials() {
        viewModelScope.launch {
            repository.refreshCredentials()
            repository.syncProfilePreferences()
        }
    }

    fun validateApiKey(
        provider: String,
        rawKey: String,
        providerConfig: Map<String, Any>? = null
    ) {
        if (rawKey.trim().length < 8) {
            showError("Enter a valid API key before validating.")
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(validatingProvider = provider) }
            repository.validateApiKey(provider, rawKey, providerConfig)
                .onSuccess { resp ->
                    _uiState.update { it.copy(validatingProvider = null) }
                    if (resp.validation.valid) {
                        showInfo(resp.validation.message)
                    } else {
                        showError(resp.validation.message)
                    }
                }
                .onFailure { err ->
                    _uiState.update { it.copy(validatingProvider = null) }
                    showError(err.message ?: "Validation failed")
                }
        }
    }

    fun saveApiKey(
        provider: String,
        rawKey: String,
        providerConfig: Map<String, Any>? = null
    ) {
        if (rawKey.trim().length < 8) {
            showError("Enter a valid API key to save.")
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(validatingProvider = provider) }
            repository.saveApiKey(provider, rawKey, providerConfig)
                .onSuccess { resp ->
                    _uiState.update { it.copy(validatingProvider = null) }
                    if (resp.validation.valid) {
                        if (provider == "groq") {
                            val current = appSettings.value
                            repository.updateProviderRouting(
                                scriptProvider = "groq",
                                researchProvider = "groq",
                                voiceProvider = current.preferredVoiceProvider,
                                mediaProviders = current.preferredMediaProviders
                            )
                            showInfo("GROQ key encrypted & saved! Script & Research set to Groq (auto-failover active).")
                        } else {
                            showInfo("${provider.uppercase()} key encrypted & saved on backend")
                        }
                    } else {
                        showError(resp.validation.message)
                    }
                }
                .onFailure { err ->
                    _uiState.update { it.copy(validatingProvider = null) }
                    showError(err.message ?: "Failed to save API key")
                }
        }
    }

    fun removeApiKey(provider: String) {
        viewModelScope.launch {
            repository.deleteApiKey(provider)
                .onSuccess { showInfo("Removed ${provider.uppercase()} API key from backend") }
                .onFailure { showError(it.message ?: "Failed to remove key") }
        }
    }

    fun initiateYouTubeConnect() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.getYouTubeConnectUrl()
                .onSuccess { url ->
                    _uiState.update { it.copy(isLoading = false, pendingOAuthUrl = url) }
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Could not start YouTube OAuth")
                }
        }
    }

    fun reportExternalError(message: String) {
        showError(message)
    }

    fun reportExternalInfo(message: String) {
        showInfo(message)
    }

    fun refreshYouTubeAccounts(showFeedback: Boolean = false) {
        viewModelScope.launch {
            repository.refreshYouTubeAccounts()
                .onSuccess {
                    if (showFeedback) {
                        showInfo("YouTube channel list synced from server")
                    }
                }
                .onFailure { err ->
                    if (showFeedback) {
                        showError(err.message ?: "Failed to refresh YouTube channels")
                    }
                }
        }
    }

    fun setDefaultYouTube(accountId: String) {
        viewModelScope.launch {
            repository.setDefaultYouTube(accountId)
                .onSuccess {
                    showInfo("Default YouTube channel updated")
                    refreshDashboard()
                }
                .onFailure { showError(it.message ?: "Could not update default channel") }
        }
    }

    fun disconnectYouTube(accountId: String? = null) {
        viewModelScope.launch {
            repository.disconnectYouTube(accountId)
                .onSuccess {
                    showInfo("YouTube channel disconnected")
                    refreshDashboard()
                }
                .onFailure { showError(it.message ?: "Disconnect failed") }
        }
    }

    fun loadAutomationSettings() {
        viewModelScope.launch {
            repository.getAutomationSettings()
                .onSuccess { schedule ->
                    _uiState.update {
                        it.copy(
                            schedule = schedule,
                            automationEnabled = schedule?.enabled ?: false,
                            nextScheduledRun = schedule?.nextRunAt
                        )
                    }
                }
        }
    }

    fun saveAutomationSettings(request: UpdateScheduleRequest) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            repository.saveAutomationSettings(request)
                .onSuccess { schedule ->
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            schedule = schedule,
                            automationEnabled = schedule?.enabled ?: request.enabled,
                            nextScheduledRun = schedule?.nextRunAt
                        )
                    }
                    showInfo("Cloud Autopilot schedule saved")
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Failed to save schedule")
                }
        }
    }

    fun toggleAutomation(enable: Boolean) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            val result = if (enable) repository.startAutomation() else repository.pauseAutomation()
            result
                .onSuccess { schedule ->
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            schedule = schedule,
                            automationEnabled = schedule?.enabled ?: enable,
                            nextScheduledRun = schedule?.nextRunAt
                        )
                    }
                    showInfo(if (enable) "Autopilot STARTED in cloud" else "Autopilot PAUSED")
                }
                .onFailure { err ->
                    _uiState.update { it.copy(isLoading = false) }
                    showError(err.message ?: "Could not toggle automation")
                }
        }
    }

    private fun showInfo(msg: String) {
        _uiState.update { it.copy(bannerMessage = msg, isErrorBanner = false) }
    }

    private fun showError(msg: String) {
        _uiState.update { it.copy(bannerMessage = msg, isErrorBanner = true) }
    }

    class Factory(private val repository: StudioRepository) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return StudioViewModel(repository) as T
        }
    }
}
