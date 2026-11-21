package com.example.core.network

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path

interface AutoTubeBackendApi {
    @GET("health")
    suspend fun getHealth(): HealthResponse

    @GET("api/dashboard")
    suspend fun getDashboard(): DashboardResponse

    // BYOK Credentials
    @GET("api/credentials")
    suspend fun getCredentials(): CredentialsListResponse

    @POST("api/credentials/validate")
    suspend fun validateCredential(@Body request: CredentialInputRequest): ValidateCredentialResponse

    @POST("api/credentials")
    suspend fun saveCredential(@Body request: CredentialInputRequest): SaveCredentialResponse

    @DELETE("api/credentials/{provider}")
    suspend fun deleteCredential(@Path("provider") provider: String): SimpleStatusResponse

    // YouTube Integration
    @POST("api/youtube/connect")
    suspend fun initiateYouTubeConnect(): YouTubeConnectResponse

    @GET("api/youtube/accounts")
    suspend fun getYouTubeAccounts(): YouTubeAccountsResponse

    @POST("api/youtube/disconnect")
    suspend fun disconnectYouTube(@Body request: YouTubeDisconnectRequest): SimpleStatusResponse

    // Topic Research & Projects
    @POST("api/research/topics")
    suspend fun researchTopics(@Body request: TopicResearchRequest): TopicResearchResponse

    @POST("api/projects")
    suspend fun createProject(@Body request: CreateProjectRequest): CreateProjectResponse

    @GET("api/projects")
    suspend fun getProjects(): ProjectsListResponse

    @GET("api/projects/{id}")
    suspend fun getProjectDetail(@Path("id") id: String): ProjectDetailResponse

    @PUT("api/projects/{id}/script")
    suspend fun updateProjectScript(
        @Path("id") id: String,
        @Body request: UpdateScriptRequest
    ): ScriptSingleResponse

    @POST("api/projects/{id}/script/regenerate")
    suspend fun regenerateProjectScript(
        @Path("id") id: String,
        @Body request: RegenerateScriptRequest
    ): ScriptSingleResponse

    @DELETE("api/projects/{id}")
    suspend fun deleteProject(@Path("id") id: String): SimpleStatusResponse

    // Jobs
    @GET("api/jobs")
    suspend fun getJobs(): JobsListResponse

    @GET("api/jobs/{id}")
    suspend fun getJobDetail(@Path("id") id: String): JobSingleResponse

    @POST("api/jobs/{id}/retry")
    suspend fun retryJob(@Path("id") id: String): JobSingleResponse

    @POST("api/jobs/{id}/cancel")
    suspend fun cancelJob(@Path("id") id: String): JobSingleResponse

    // Automation
    @GET("api/automation/settings")
    suspend fun getAutomationSettings(): ScheduleResponse

    @PUT("api/automation/settings")
    suspend fun updateAutomationSettings(@Body request: UpdateScheduleRequest): ScheduleResponse

    @POST("api/automation/start")
    suspend fun startAutomation(): ScheduleResponse

    @POST("api/automation/pause")
    suspend fun pauseAutomation(): ScheduleResponse

    // Notifications
    @GET("api/notifications")
    suspend fun getNotifications(): NotificationsListResponse
}
