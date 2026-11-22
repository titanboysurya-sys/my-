package com.example.core.network

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

// --- Health Check ---
@JsonClass(generateAdapter = true)
data class HealthResponse(
    val status: String = "unknown",
    val service: String = "",
    val supabaseConfigured: Boolean = false,
    val encryptionConfigured: Boolean = false,
    val youtubeOAuthConfigured: Boolean = false
)

// --- Supabase Auth REST DTOs ---
@JsonClass(generateAdapter = true)
data class SupabaseAuthRequest(
    val email: String,
    val password: String
)

@JsonClass(generateAdapter = true)
data class SupabaseIdTokenRequest(
    val provider: String = "google",
    @Json(name = "id_token") val idToken: String,
    val nonce: String? = null
)

@JsonClass(generateAdapter = true)
data class SupabaseRefreshRequest(
    @Json(name = "refresh_token") val refreshToken: String
)

@JsonClass(generateAdapter = true)
data class SupabaseAuthUser(
    val id: String,
    val email: String? = null
)

@JsonClass(generateAdapter = true)
data class SupabaseAuthResponse(
    @Json(name = "access_token") val accessToken: String? = null,
    @Json(name = "refresh_token") val refreshToken: String? = null,
    @Json(name = "expires_in") val expiresIn: Long? = 3600,
    val user: SupabaseAuthUser? = null
)

// --- Dashboard ---
@JsonClass(generateAdapter = true)
data class DashboardStatsDto(
    val todayJobs: Int = 0,
    val completedVideos: Int = 0,
    val failedJobs: Int = 0,
    val scheduledVideos: Int = 0,
    val connectedProvidersCount: Int = 0
)

@JsonClass(generateAdapter = true)
data class DashboardResponse(
    val connectedChannel: YouTubeChannelDto? = null,
    val automationEnabled: Boolean = false,
    val nextScheduledRun: String? = null,
    val stats: DashboardStatsDto = DashboardStatsDto(),
    val recentJobs: List<VideoJobDto> = emptyList(),
    val recentNotifications: List<NotificationDto> = emptyList()
)

// --- BYOK Credentials ---
@JsonClass(generateAdapter = true)
data class MaskedCredentialDto(
    val provider: String,
    val status: String = "not_connected",
    val maskedKey: String? = null,
    val lastValidatedAt: String? = null,
    val lastError: String? = null,
    val usageInfo: Map<String, Any?>? = null,
    val docsUrl: String = ""
)

@JsonClass(generateAdapter = true)
data class CredentialsListResponse(
    val credentials: List<MaskedCredentialDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class CredentialInputRequest(
    val provider: String,
    val apiKey: String,
    val providerConfig: Map<String, Any>? = null,
    val skipValidation: Boolean = false
)

@JsonClass(generateAdapter = true)
data class CredentialValidationDto(
    val valid: Boolean = false,
    val status: String = "invalid_key",
    val message: String = ""
)

@JsonClass(generateAdapter = true)
data class ValidateCredentialResponse(
    val validation: CredentialValidationDto
)

@JsonClass(generateAdapter = true)
data class SaveCredentialResponse(
    val record: MaskedCredentialDto,
    val validation: CredentialValidationDto
)

// --- YouTube OAuth & Accounts ---
@JsonClass(generateAdapter = true)
data class YouTubeConnectResponse(
    val authUrl: String
)

@JsonClass(generateAdapter = true)
data class YouTubeChannelDto(
    val id: String,
    val channelId: String,
    val channelName: String,
    val channelHandle: String? = null,
    val channelThumbnailUrl: String? = null,
    val subscriberCount: Long = 0,
    val tokenStatus: String = "connected",
    val isDefault: Boolean = true,
    val connectedAt: String = ""
)

@JsonClass(generateAdapter = true)
data class YouTubeAccountsResponse(
    val accounts: List<YouTubeChannelDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class YouTubeDisconnectRequest(
    val accountId: String? = null
)

// --- Topic Research ---
@JsonClass(generateAdapter = true)
data class TopicResearchRequest(
    val niche: String,
    val language: String = "en",
    val audienceCountry: String = "US",
    val contentStyle: String = "documentary",
    val durationSeconds: Int = 60,
    val topicType: String = "evergreen",
    val count: Int = 5
)

@JsonClass(generateAdapter = true)
data class ResearchReferenceDto(
    val title: String = "",
    val source: String = "",
    val url: String = "",
    val publishedAt: String = ""
)

@JsonClass(generateAdapter = true)
data class TopicSuggestionDto(
    val topic: String = "",
    val angle: String = "",
    val whyNow: String = "",
    val references: List<ResearchReferenceDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class TopicResearchResponse(
    val suggestions: List<TopicSuggestionDto> = emptyList(),
    val verifiedReferences: List<ResearchReferenceDto> = emptyList()
)

// --- Projects, Scripts, Scenes ---
@JsonClass(generateAdapter = true)
data class CreateProjectRequest(
    val title: String? = null,
    val topic: String,
    val niche: String = "Facts",
    val language: String = "en",
    val audienceCountry: String = "US",
    val contentStyle: String = "documentary",
    val topicType: String = "evergreen",
    val format: String = "9:16",
    val durationSeconds: Int = 60,
    val qualityPreset: String = "1080p",
    val autoProduce: Boolean = true,
    val voiceProvider: String = "gemini_tts",
    val voiceId: String = "Kore",
    val autoUpload: Boolean = false,
    val privacyStatus: String = "private",
    val scheduledPublishTime: String? = null,
    val startImmediately: Boolean = true
)

@JsonClass(generateAdapter = true)
data class ProjectDto(
    val id: String,
    @Json(name = "user_id") val userId: String = "",
    val title: String = "",
    val topic: String = "",
    val niche: String = "Facts",
    val language: String = "en",
    val format: String = "9:16",
    @Json(name = "duration_seconds") val durationSeconds: Int = 60,
    @Json(name = "quality_preset") val qualityPreset: String = "1080p",
    val status: String = "queued",
    @Json(name = "thumbnail_signed_url") val thumbnailSignedUrl: String? = null,
    @Json(name = "video_signed_url") val videoSignedUrl: String? = null,
    @Json(name = "created_at") val createdAt: String = ""
)

@JsonClass(generateAdapter = true)
data class CreateProjectResponse(
    val project: ProjectDto,
    val job: VideoJobDto? = null
)

@JsonClass(generateAdapter = true)
data class ProjectsListResponse(
    val projects: List<ProjectDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class ScriptDto(
    val id: String,
    val version: Int = 1,
    @Json(name = "title_idea") val titleIdea: String = "",
    val hook: String = "",
    @Json(name = "narration_text") val narrationText: String = "",
    @Json(name = "script_text") val scriptText: String = "",
    @Json(name = "word_count") val wordCount: Int = 0,
    val approved: Boolean = false,
    @Json(name = "created_at") val createdAt: String = ""
)

@JsonClass(generateAdapter = true)
data class SceneDto(
    val id: String,
    @Json(name = "scene_number") val sceneNumber: Int = 1,
    val narration: String = "",
    @Json(name = "visual_description") val visualDescription: String = "",
    @Json(name = "primary_keyword") val primaryKeyword: String = "",
    val duration: Double = 5.0,
    val status: String = "pending",
    @Json(name = "fallback_used") val fallbackUsed: Boolean = false
)

@JsonClass(generateAdapter = true)
data class ProjectDetailResponse(
    val project: ProjectDto,
    val scripts: List<ScriptDto> = emptyList(),
    val scenes: List<SceneDto> = emptyList(),
    val jobs: List<VideoJobDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class UpdateScriptRequest(
    val narrationText: String,
    val titleIdea: String? = null,
    val approveAndContinue: Boolean = false
)

@JsonClass(generateAdapter = true)
data class ScriptSingleResponse(
    val script: ScriptDto
)

@JsonClass(generateAdapter = true)
data class RegenerateScriptRequest(
    val tone: String? = null,
    val durationSeconds: Int? = null
)

// --- Video Jobs ---
@JsonClass(generateAdapter = true)
data class EmbeddedProjectMeta(
    val title: String? = null,
    val topic: String? = null,
    val format: String? = null
)

@JsonClass(generateAdapter = true)
data class VideoJobDto(
    val id: String,
    @Json(name = "user_id") val userId: String = "",
    @Json(name = "project_id") val projectId: String = "",
    @Json(name = "job_type") val jobType: String = "full_pipeline",
    val status: String = "queued",
    val progress: Int = 0,
    @Json(name = "current_stage") val currentStage: String = "queued",
    @Json(name = "status_message") val statusMessage: String = "",
    @Json(name = "completed_stages") val completedStages: List<String>? = emptyList(),
    @Json(name = "retry_count") val retryCount: Int = 0,
    @Json(name = "error_message") val errorMessage: String? = null,
    @Json(name = "created_at") val createdAt: String = "",
    @Json(name = "updated_at") val updatedAt: String = "",
    val projects: EmbeddedProjectMeta? = null
)

@JsonClass(generateAdapter = true)
data class JobsListResponse(
    val jobs: List<VideoJobDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class JobSingleResponse(
    val job: VideoJobDto
)

// --- Automation Schedule ---
@JsonClass(generateAdapter = true)
data class ScheduleDto(
    val id: String? = null,
    val enabled: Boolean = false,
    val niche: String = "Facts",
    val language: String = "en",
    @Json(name = "audience_country") val audienceCountry: String = "US",
    @Json(name = "video_format") val videoFormat: String = "9:16",
    @Json(name = "duration_seconds") val durationSeconds: Int = 60,
    @Json(name = "videos_per_day") val videosPerDay: Int = 1,
    @Json(name = "publishing_times") val publishingTimes: List<String> = listOf("14:00"),
    @Json(name = "days_of_week") val daysOfWeek: List<String> = listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun"),
    val timezone: String = "UTC",
    val preferences: Map<String, Any?>? = null,
    @Json(name = "next_run_at") val nextRunAt: String? = null
)

@JsonClass(generateAdapter = true)
data class ScheduleResponse(
    val schedule: ScheduleDto? = null
)

@JsonClass(generateAdapter = true)
data class UpdateScheduleRequest(
    val enabled: Boolean,
    val niche: String,
    val language: String,
    val audienceCountry: String,
    val videoFormat: String,
    val durationSeconds: Int,
    val videosPerDay: Int,
    val publishingTimes: List<String>,
    val daysOfWeek: List<String>,
    val timezone: String,
    val preferences: Map<String, Any>
)

// --- Notifications & Generic Responses ---
@JsonClass(generateAdapter = true)
data class NotificationDto(
    val id: String,
    @Json(name = "event_type") val eventType: String = "",
    val title: String = "",
    val body: String = "",
    @Json(name = "created_at") val createdAt: String = ""
)

@JsonClass(generateAdapter = true)
data class NotificationsListResponse(
    val notifications: List<NotificationDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class SimpleStatusResponse(
    val deleted: Boolean? = null,
    val removed: Boolean? = null,
    val disconnected: Boolean? = null
)
