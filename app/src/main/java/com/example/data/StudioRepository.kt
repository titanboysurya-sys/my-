package com.example.data

import com.example.core.database.AutoTubeDatabase
import com.example.core.database.CachedCredentialEntity
import com.example.core.database.CachedJobEntity
import com.example.core.database.CachedNotificationEntity
import com.example.core.database.CachedProjectEntity
import com.example.core.database.CachedYouTubeChannelEntity
import com.example.core.datastore.StudioAppSettings
import com.example.core.datastore.StudioPreferencesStore
import com.example.core.network.CreateProjectRequest
import com.example.core.network.CreateProjectResponse
import com.example.core.network.CredentialInputRequest
import com.example.core.network.DashboardResponse
import com.example.core.network.DynamicBackendClient
import com.example.core.network.HealthResponse
import com.example.core.network.ProfilePreferencesRequest
import com.example.core.network.ProjectDetailResponse
import com.example.core.network.ProjectDto
import com.example.core.network.PublishProjectRequest
import com.example.core.network.RegenerateScriptRequest
import com.example.core.network.RerenderProjectRequest
import com.example.core.network.SaveCredentialResponse
import com.example.core.network.ScheduleDto
import com.example.core.network.ScriptDto
import android.net.Uri
import com.example.core.network.SupabaseAuthRequest
import com.example.core.network.SupabaseIdTokenRequest
import com.example.core.network.TopicResearchRequest
import com.example.core.network.TopicResearchResponse
import com.example.core.network.UpdateProjectSettingsRequest
import com.example.core.network.UpdateScheduleRequest
import com.example.core.network.UpdateScriptRequest
import com.example.core.network.ValidateCredentialResponse
import com.example.core.network.VideoJobDto
import com.example.core.network.VoiceCatalogItemDto
import com.example.core.network.VoicePreviewRequest
import com.example.core.network.VoicePreviewResponse
import com.example.core.network.SetDefaultYouTubeRequest
import com.example.core.network.YouTubeDisconnectRequest
import com.example.core.security.AuthSession
import com.example.core.security.SecureSessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.withContext
import retrofit2.HttpException
import java.io.IOException

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class StudioRepository(
    private val database: AutoTubeDatabase,
    private val client: DynamicBackendClient,
    private val sessionStore: SecureSessionStore,
    private val prefsStore: StudioPreferencesStore
) {
    val authSession: StateFlow<AuthSession?> = sessionStore.session
    val appSettings: Flow<StudioAppSettings> = prefsStore.settingsFlow

    val projectsFlow: Flow<List<CachedProjectEntity>> = authSession.flatMapLatest { session ->
        if (session == null) flowOf(emptyList()) else database.projectDao().observeProjects(session.userId)
    }

    val jobsFlow: Flow<List<CachedJobEntity>> = authSession.flatMapLatest { session ->
        if (session == null) flowOf(emptyList()) else database.jobDao().observeJobs(session.userId)
    }

    val credentialsFlow: Flow<List<CachedCredentialEntity>> = authSession.flatMapLatest { session ->
        if (session == null) flowOf(emptyList()) else database.credentialDao().observeCredentials(session.userId)
    }

    val youtubeChannelsFlow: Flow<List<CachedYouTubeChannelEntity>> = authSession.flatMapLatest { session ->
        if (session == null) flowOf(emptyList()) else database.youTubeChannelDao().observeChannels(session.userId)
    }

    val notificationsFlow: Flow<List<CachedNotificationEntity>> = authSession.flatMapLatest { session ->
        if (session == null) flowOf(emptyList()) else database.notificationDao().observeNotifications(session.userId)
    }

    fun observeJobById(jobId: String): Flow<CachedJobEntity?> = authSession.flatMapLatest { session ->
        if (session == null) flowOf(null) else database.jobDao().observeJobById(jobId, session.userId)
    }

    suspend fun saveCloudEndpoints(
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String
    ) {
        prefsStore.updateCloudEndpoints(backendUrl, supabaseUrl, supabaseAnonKey)
    }

    suspend fun updateAppPreferences(
        darkTheme: Boolean? = null,
        language: String? = null,
        defaultQuality: String? = null,
        defaultFormat: String? = null,
        notificationsEnabled: Boolean? = null
    ) {
        prefsStore.updateAppPreferences(
            darkTheme = darkTheme,
            language = language,
            defaultQuality = defaultQuality,
            defaultFormat = defaultFormat,
            notificationsEnabled = notificationsEnabled
        )
    }

    suspend fun updateProviderRouting(
        scriptProvider: String,
        researchProvider: String,
        voiceProvider: String,
        mediaProviders: String
    ): Result<Unit> {
        prefsStore.updateProviderRouting(scriptProvider, researchProvider, voiceProvider, mediaProviders)
        return safeApiCall {
            val mediaList = mediaProviders.split(",").map { it.trim() }.filter { it.isNotBlank() }
            client.backendApi().updateProfilePreferences(
                ProfilePreferencesRequest(
                    preferences = mapOf(
                        "script_provider" to scriptProvider,
                        "research_provider" to researchProvider,
                        "voice_provider" to voiceProvider,
                        "media_providers" to mediaList
                    )
                )
            )
            Unit
        }
    }

    suspend fun syncProfilePreferences(): Result<Unit> = safeApiCall {
        val prefs = client.backendApi().getProfile().profile?.preferences ?: return@safeApiCall
        val current = prefsStore.currentSettings()
        val script = (prefs["script_provider"] as? String)?.takeIf { it.isNotBlank() }
            ?: current.preferredScriptProvider
        val research = (prefs["research_provider"] as? String)?.takeIf { it.isNotBlank() }
            ?: current.preferredResearchProvider
        val voice = (prefs["voice_provider"] as? String)?.takeIf { it.isNotBlank() }
            ?: current.preferredVoiceProvider
        val media = when (val raw = prefs["media_providers"]) {
            is List<*> -> raw.filterIsInstance<String>().joinToString(",").ifBlank { current.preferredMediaProviders }
            is String -> raw.ifBlank { current.preferredMediaProviders }
            else -> current.preferredMediaProviders
        }
        prefsStore.updateProviderRouting(script, research, voice, media)
        val savedVoiceId = (prefs["voice_id"] as? String)?.takeIf { it.isNotBlank() } ?: current.preferredVoiceId
        val savedVoiceSpeed = (prefs["voice_speed"] as? Number)?.toDouble() ?: current.preferredVoiceSpeed
        prefsStore.updateVoiceDefaults(voice, savedVoiceId, savedVoiceSpeed)
    }

    suspend fun getVoicesCatalog(): Result<List<VoiceCatalogItemDto>> = safeApiCall {
        client.backendApi().getVoicesCatalog().voices
    }

    suspend fun previewVoice(request: VoicePreviewRequest): Result<VoicePreviewResponse> = safeApiCall {
        client.backendApi().previewVoice(request)
    }

    suspend fun updateVoiceDefaults(
        voiceProvider: String,
        voiceId: String,
        voiceSpeed: Double
    ): Result<Unit> {
        prefsStore.updateVoiceDefaults(voiceProvider, voiceId, voiceSpeed)
        return safeApiCall {
            client.backendApi().updateProfilePreferences(
                ProfilePreferencesRequest(
                    preferences = mapOf(
                        "voice_provider" to voiceProvider,
                        "voice_id" to voiceId,
                        "voice_speed" to voiceSpeed
                    )
                )
            )
            Unit
        }
    }

    suspend fun checkBackendHealth(overrideUrl: String? = null): Result<HealthResponse> =
        safeApiCall {
            client.backendApi(overrideUrl).getHealth()
        }

    suspend fun signIn(
        email: String,
        password: String,
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String
    ): Result<AuthSession> = safeApiCall {
        prefsStore.updateCloudEndpoints(backendUrl, supabaseUrl, supabaseAnonKey)
        require(supabaseAnonKey.isNotBlank()) { "Supabase Anon Key is required for sign-in." }

        val res = client.supabaseAuthApi(supabaseUrl).signInWithPassword(
            anonKey = supabaseAnonKey.trim(),
            body = SupabaseAuthRequest(email.trim(), password)
        )
        val accessToken = res.accessToken
            ?: throw IllegalStateException("Supabase did not return an access token.")
        val user = res.user
            ?: throw IllegalStateException("Supabase response missing user account details.")

        val session = AuthSession(
            userId = user.id,
            email = user.email ?: email.trim(),
            accessToken = accessToken,
            refreshToken = res.refreshToken ?: "",
            expiresAtEpochSec = (System.currentTimeMillis() / 1000L) + (res.expiresIn ?: 3600L)
        )
        sessionStore.saveSession(session)
        session
    }

    suspend fun signInWithGoogleIdToken(
        idToken: String,
        nonce: String? = null,
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String,
        googleWebClientId: String
    ): Result<AuthSession> = safeApiCall {
        prefsStore.updateCloudEndpoints(backendUrl, supabaseUrl, supabaseAnonKey, googleWebClientId)
        require(supabaseAnonKey.isNotBlank()) { "Supabase Anon Key is required for Google Sign-In." }

        val res = client.supabaseAuthApi(supabaseUrl).signInWithIdToken(
            anonKey = supabaseAnonKey.trim(),
            body = SupabaseIdTokenRequest(
                provider = "google",
                idToken = idToken,
                nonce = nonce?.takeIf { it.isNotBlank() }
            )
        )
        val accessToken = res.accessToken
            ?: throw IllegalStateException("Supabase did not return an access token for Google Sign-In.")
        val user = res.user
            ?: throw IllegalStateException("Supabase response missing user account details.")

        val session = AuthSession(
            userId = user.id,
            email = user.email ?: "Google Creator",
            accessToken = accessToken,
            refreshToken = res.refreshToken ?: "",
            expiresAtEpochSec = (System.currentTimeMillis() / 1000L) + (res.expiresIn ?: 3600L)
        )
        sessionStore.saveSession(session)
        session
    }

    suspend fun buildSupabaseGoogleOAuthUrl(
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String,
        googleWebClientId: String
    ): Result<String> = safeApiCall {
        prefsStore.updateCloudEndpoints(backendUrl, supabaseUrl, supabaseAnonKey, googleWebClientId)
        val cleanSupabase = supabaseUrl.trim().trimEnd('/')
        require(cleanSupabase.startsWith("https://")) { "Enter a valid HTTPS Supabase Project URL first." }
        require(supabaseAnonKey.isNotBlank()) { "Enter your Supabase Publishable / Anon Key first." }
        val redirect = Uri.encode("autotubestudio://oauth/supabase")
        "$cleanSupabase/auth/v1/authorize?provider=google&redirect_to=$redirect"
    }

    suspend fun completeSupabaseOAuthSession(
        accessToken: String,
        refreshToken: String,
        expiresInSec: Long
    ): Result<AuthSession> = safeApiCall {
        val current = prefsStore.currentSettings()
        require(current.supabaseAnonKey.isNotBlank()) { "Supabase Publishable / Anon Key is missing." }
        val user = client.supabaseAuthApi(current.supabaseUrl).getCurrentUser(
            anonKey = current.supabaseAnonKey.trim(),
            bearerToken = "Bearer $accessToken"
        )
        val session = AuthSession(
            userId = user.id,
            email = user.email ?: "Google Creator",
            accessToken = accessToken,
            refreshToken = refreshToken,
            expiresAtEpochSec = (System.currentTimeMillis() / 1000L) + expiresInSec
        )
        sessionStore.saveSession(session)
        session
    }

    suspend fun signUp(
        email: String,
        password: String,
        backendUrl: String,
        supabaseUrl: String,
        supabaseAnonKey: String
    ): Result<String> = safeApiCall {
        prefsStore.updateCloudEndpoints(backendUrl, supabaseUrl, supabaseAnonKey)
        require(supabaseAnonKey.isNotBlank()) { "Supabase Anon Key is required to create an account." }

        val res = client.supabaseAuthApi(supabaseUrl).signUp(
            anonKey = supabaseAnonKey.trim(),
            body = SupabaseAuthRequest(email.trim(), password)
        )
        if (res.accessToken != null && res.user != null) {
            sessionStore.saveSession(
                AuthSession(
                    userId = res.user.id,
                    email = res.user.email ?: email.trim(),
                    accessToken = res.accessToken,
                    refreshToken = res.refreshToken ?: "",
                    expiresAtEpochSec = (System.currentTimeMillis() / 1000L) + (res.expiresIn ?: 3600L)
                )
            )
            "Account created and signed in."
        } else {
            "Account created. Check your email inbox to confirm your address, then sign in."
        }
    }

    suspend fun signOut() = withContext(Dispatchers.IO) {
        sessionStore.clearSession()
    }

    suspend fun clearLocalCache() = withContext(Dispatchers.IO) {
        val uid = sessionStore.currentSession()?.userId ?: return@withContext
        database.projectDao().clearForUser(uid)
        database.jobDao().clearForUser(uid)
        database.credentialDao().clearForUser(uid)
        database.youTubeChannelDao().clearForUser(uid)
        database.notificationDao().clearForUser(uid)
    }

    suspend fun deleteAccountAndData(): Result<Unit> = safeApiCall {
        client.backendApi().deleteAccount()
        clearLocalCache()
        sessionStore.clearSession()
    }

    suspend fun refreshDashboard(): Result<DashboardResponse> = safeApiCall {
        val uid = requireUserId()
        val resp = client.backendApi().getDashboard()

        resp.connectedChannel?.let { ch ->
            database.youTubeChannelDao().upsertAll(
                listOf(
                    CachedYouTubeChannelEntity(
                        id = ch.id,
                        userId = uid,
                        channelId = ch.channelId,
                        channelName = ch.channelName,
                        channelHandle = ch.channelHandle,
                        thumbnailUrl = ch.channelThumbnailUrl,
                        subscriberCount = ch.subscriberCount,
                        tokenStatus = ch.tokenStatus,
                        isDefault = ch.isDefault,
                        connectedAt = ch.connectedAt
                    )
                )
            )
        }

        if (resp.recentJobs.isNotEmpty()) {
            database.jobDao().upsertAll(resp.recentJobs.map { it.toEntity(uid) })
        }
        if (resp.recentNotifications.isNotEmpty()) {
            database.notificationDao().upsertAll(
                resp.recentNotifications.map { n ->
                    CachedNotificationEntity(
                        id = n.id,
                        userId = uid,
                        eventType = n.eventType,
                        title = n.title,
                        body = n.body,
                        createdAt = n.createdAt
                    )
                }
            )
        }
        resp
    }

    suspend fun refreshProjects(): Result<Unit> = safeApiCall {
        val uid = requireUserId()
        val resp = client.backendApi().getProjects()
        database.projectDao().clearForUser(uid)
        database.projectDao().upsertAll(
            resp.projects.map { p ->
                CachedProjectEntity(
                    id = p.id,
                    userId = uid,
                    title = p.title,
                    topic = p.topic,
                    niche = p.niche,
                    language = p.language,
                    format = p.format,
                    durationSeconds = p.durationSeconds,
                    qualityPreset = p.qualityPreset,
                    status = p.status,
                    thumbnailUrl = p.thumbnailSignedUrl,
                    videoUrl = p.videoSignedUrl,
                    createdAt = p.createdAt
                )
            }
        )
    }

    suspend fun getProjectDetail(projectId: String): Result<ProjectDetailResponse> = safeApiCall {
        client.backendApi().getProjectDetail(projectId)
    }

    suspend fun updateProjectScript(
        projectId: String,
        narrationText: String,
        titleIdea: String?,
        approveAndContinue: Boolean
    ): Result<ScriptDto> = safeApiCall {
        client.backendApi().updateProjectScript(
            projectId,
            UpdateScriptRequest(narrationText, titleIdea, approveAndContinue)
        ).script
    }

    suspend fun regenerateProjectScript(
        projectId: String,
        tone: String?,
        durationSeconds: Int?
    ): Result<ScriptDto> = safeApiCall {
        client.backendApi().regenerateProjectScript(
            projectId,
            RegenerateScriptRequest(tone, durationSeconds)
        ).script
    }

    suspend fun updateProjectSettings(
        projectId: String,
        request: UpdateProjectSettingsRequest
    ): Result<ProjectDto> = safeApiCall {
        client.backendApi().updateProjectSettings(projectId, request).project
    }

    suspend fun rerenderProject(
        projectId: String,
        request: RerenderProjectRequest
    ): Result<VideoJobDto> = safeApiCall {
        val uid = requireUserId()
        val job = client.backendApi().rerenderProject(projectId, request).job
        database.jobDao().upsert(job.toEntity(uid))
        job
    }

    suspend fun publishProject(
        projectId: String,
        request: PublishProjectRequest
    ): Result<VideoJobDto> = safeApiCall {
        val uid = requireUserId()
        val job = client.backendApi().publishProject(projectId, request).job
        database.jobDao().upsert(job.toEntity(uid))
        job
    }

    suspend fun deleteProject(projectId: String): Result<Unit> = safeApiCall {
        val uid = requireUserId()
        client.backendApi().deleteProject(projectId)
        database.projectDao().deleteById(projectId, uid)
    }

    suspend fun researchTopics(request: TopicResearchRequest): Result<TopicResearchResponse> =
        safeApiCall {
            client.backendApi().researchTopics(request)
        }

    suspend fun createProjectAndStart(request: CreateProjectRequest): Result<CreateProjectResponse> =
        safeApiCall {
            val uid = requireUserId()
            val resp = client.backendApi().createProject(request)
            database.projectDao().upsertAll(
                listOf(
                    CachedProjectEntity(
                        id = resp.project.id,
                        userId = uid,
                        title = resp.project.title,
                        topic = resp.project.topic,
                        niche = resp.project.niche,
                        language = resp.project.language,
                        format = resp.project.format,
                        durationSeconds = resp.project.durationSeconds,
                        qualityPreset = resp.project.qualityPreset,
                        status = resp.project.status,
                        thumbnailUrl = resp.project.thumbnailSignedUrl,
                        videoUrl = resp.project.videoSignedUrl,
                        createdAt = resp.project.createdAt
                    )
                )
            )
            resp.job?.let { database.jobDao().upsert(it.toEntity(uid)) }
            resp
        }

    suspend fun refreshJobs(): Result<List<VideoJobDto>> = safeApiCall {
        val uid = requireUserId()
        val resp = client.backendApi().getJobs()
        database.jobDao().upsertAll(resp.jobs.map { it.toEntity(uid) })
        resp.jobs
    }

    suspend fun refreshJobDetail(jobId: String): Result<VideoJobDto> = safeApiCall {
        val uid = requireUserId()
        val job = client.backendApi().getJobDetail(jobId).job
        database.jobDao().upsert(job.toEntity(uid))
        job
    }

    suspend fun retryJob(jobId: String): Result<VideoJobDto> = safeApiCall {
        val uid = requireUserId()
        val job = client.backendApi().retryJob(jobId).job
        database.jobDao().upsert(job.toEntity(uid))
        job
    }

    suspend fun cancelJob(jobId: String): Result<VideoJobDto> = safeApiCall {
        val uid = requireUserId()
        val job = client.backendApi().cancelJob(jobId).job
        database.jobDao().upsert(job.toEntity(uid))
        job
    }

    suspend fun refreshCredentials(): Result<Unit> = safeApiCall {
        val uid = requireUserId()
        val resp = client.backendApi().getCredentials()
        database.credentialDao().upsertAll(
            resp.credentials.map { c ->
                val usageText = c.usageInfo?.entries
                    ?.take(2)
                    ?.joinToString(" • ") { "${it.key}: ${it.value}" }
                    ?.ifBlank { null }
                CachedCredentialEntity(
                    userId = uid,
                    provider = c.provider,
                    status = c.status,
                    maskedKey = c.maskedKey,
                    lastValidatedAt = c.lastValidatedAt,
                    lastError = c.lastError,
                    usageSummary = usageText,
                    docsUrl = c.docsUrl
                )
            }
        )
    }

    suspend fun validateApiKey(
        provider: String,
        apiKey: String,
        providerConfig: Map<String, Any>? = null
    ): Result<ValidateCredentialResponse> =
        safeApiCall {
            client.backendApi().validateCredential(
                CredentialInputRequest(
                    provider = provider,
                    apiKey = apiKey,
                    providerConfig = providerConfig
                )
            )
        }

    suspend fun saveApiKey(
        provider: String,
        apiKey: String,
        providerConfig: Map<String, Any>? = null
    ): Result<SaveCredentialResponse> =
        safeApiCall {
            val res = client.backendApi().saveCredential(
                CredentialInputRequest(
                    provider = provider,
                    apiKey = apiKey,
                    providerConfig = providerConfig
                )
            )
            refreshCredentials()
            res
        }

    suspend fun deleteApiKey(provider: String): Result<Unit> = safeApiCall {
        client.backendApi().deleteCredential(provider)
        refreshCredentials()
    }

    suspend fun getYouTubeConnectUrl(): Result<String> = safeApiCall {
        client.backendApi().initiateYouTubeConnect().authUrl
    }

    suspend fun refreshYouTubeAccounts(): Result<Unit> = safeApiCall {
        val uid = requireUserId()
        val resp = client.backendApi().getYouTubeAccounts()
        database.youTubeChannelDao().clearForUser(uid)
        database.youTubeChannelDao().upsertAll(
            resp.accounts.map { ch ->
                CachedYouTubeChannelEntity(
                    id = ch.id,
                    userId = uid,
                    channelId = ch.channelId,
                    channelName = ch.channelName,
                    channelHandle = ch.channelHandle,
                    thumbnailUrl = ch.channelThumbnailUrl,
                    subscriberCount = ch.subscriberCount,
                    tokenStatus = ch.tokenStatus,
                    isDefault = ch.isDefault,
                    connectedAt = ch.connectedAt
                )
            }
        )
    }

    suspend fun setDefaultYouTube(accountId: String): Result<Unit> = safeApiCall {
        val uid = requireUserId()
        val resp = client.backendApi().setDefaultYouTube(SetDefaultYouTubeRequest(accountId))
        database.youTubeChannelDao().clearForUser(uid)
        database.youTubeChannelDao().upsertAll(
            resp.accounts.map { ch ->
                CachedYouTubeChannelEntity(
                    id = ch.id,
                    userId = uid,
                    channelId = ch.channelId,
                    channelName = ch.channelName,
                    channelHandle = ch.channelHandle,
                    thumbnailUrl = ch.channelThumbnailUrl,
                    subscriberCount = ch.subscriberCount,
                    tokenStatus = ch.tokenStatus,
                    isDefault = ch.isDefault,
                    connectedAt = ch.connectedAt
                )
            }
        )
    }

    suspend fun disconnectYouTube(accountId: String? = null): Result<Unit> = safeApiCall {
        val uid = requireUserId()
        client.backendApi().disconnectYouTube(YouTubeDisconnectRequest(accountId))
        refreshYouTubeAccounts()
    }

    suspend fun getAutomationSettings(): Result<ScheduleDto?> = safeApiCall {
        client.backendApi().getAutomationSettings().schedule
    }

    suspend fun saveAutomationSettings(request: UpdateScheduleRequest): Result<ScheduleDto?> =
        safeApiCall {
            client.backendApi().updateAutomationSettings(request).schedule
        }

    suspend fun startAutomation(): Result<ScheduleDto?> = safeApiCall {
        client.backendApi().startAutomation().schedule
    }

    suspend fun pauseAutomation(): Result<ScheduleDto?> = safeApiCall {
        client.backendApi().pauseAutomation().schedule
    }

    suspend fun fetchLatestNotifications(): Result<List<CachedNotificationEntity>> = safeApiCall {
        val uid = requireUserId()
        val items = client.backendApi().getNotifications().notifications.map { n ->
            CachedNotificationEntity(
                id = n.id,
                userId = uid,
                eventType = n.eventType,
                title = n.title,
                body = n.body,
                createdAt = n.createdAt
            )
        }
        database.notificationDao().upsertAll(items)
        items
    }

    private fun requireUserId(): String =
        sessionStore.currentSession()?.userId
            ?: throw IllegalStateException("Please sign in first.")

    private fun VideoJobDto.toEntity(uid: String) = CachedJobEntity(
        id = id,
        userId = uid,
        projectId = projectId,
        projectTitle = projects?.title ?: projects?.topic ?: "Video Project",
        jobType = jobType,
        status = status,
        progress = progress,
        currentStage = currentStage,
        statusMessage = statusMessage,
        completedStagesCsv = (completedStages ?: emptyList()).joinToString(","),
        retryCount = retryCount,
        errorMessage = errorMessage,
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun extractReadableHttpError(rawBody: String?, statusCode: Int): String? {
        val trimmed = rawBody?.trim().orEmpty()
        if (trimmed.isBlank()) return null
        // Never dump raw HTML gateway pages (e.g. Render 502/503 HTML) into the UI banner
        if (trimmed.startsWith("<!DOCTYPE", ignoreCase = true) ||
            trimmed.startsWith("<html", ignoreCase = true) ||
            trimmed.contains("<head>", ignoreCase = true)
        ) {
            return when (statusCode) {
                502, 503, 504 ->
                    "Cloud server is restarting or temporarily busy (HTTP $statusCode). Wait 15 seconds and tap Refresh."
                else -> "Cloud server returned an unexpected response (HTTP $statusCode). Please retry."
            }
        }
        // Extract JSON error/msg/error_description from Supabase or Express JSON payloads
        val jsonPatterns = listOf(
            Regex("\"error_description\"\\s*:\\s*\"([^\"]+)\""),
            Regex("\"msg\"\\s*:\\s*\"([^\"]+)\""),
            Regex("\"message\"\\s*:\\s*\"([^\"]+)\""),
            Regex("\"error\"\\s*:\\s*\"([^\"]+)\"")
        )
        for (pattern in jsonPatterns) {
            val match = pattern.find(trimmed)?.groupValues?.getOrNull(1)
            if (!match.isNullOrBlank()) return match
        }
        return trimmed.take(220)
    }

    private suspend fun <T> safeApiCall(block: suspend () -> T): Result<T> =
        withContext(Dispatchers.IO) {
            try {
                Result.success(block())
            } catch (e: HttpException) {
                val rawErr = e.response()?.errorBody()?.string()?.take(500)
                val parsed = extractReadableHttpError(rawErr, e.code())
                val friendly = when (e.code()) {
                    401 -> parsed ?: "Session expired or unauthorized. Please sign in again."
                    403 -> parsed ?: "Access denied or provider permission error."
                    404 -> parsed ?: "Resource not found on backend."
                    422 -> parsed ?: "Validation failed — check your input or API key."
                    429 -> "Rate limit reached. Please retry in a moment."
                    502, 503, 504 ->
                        "Cloud server is restarting or temporarily busy (HTTP ${e.code()}). Wait 15 seconds and tap Refresh."
                    else -> parsed ?: "Server error (HTTP ${e.code()})."
                }
                Result.failure(Exception(friendly))
            } catch (e: IOException) {
                Result.failure(
                    Exception("Cannot reach cloud backend. Verify Backend URL & network connection (${e.localizedMessage ?: "network error"}).")
                )
            } catch (e: Throwable) {
                Result.failure(Exception(e.message ?: "Unexpected error occurred"))
            }
        }
}
