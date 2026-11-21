package com.example.core.database

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "cached_projects",
    indices = [Index(value = ["userId", "createdAt"])]
)
data class CachedProjectEntity(
    @PrimaryKey val id: String,
    val userId: String,
    val title: String,
    val topic: String,
    val niche: String,
    val language: String,
    val format: String,
    val durationSeconds: Int,
    val qualityPreset: String,
    val status: String,
    val thumbnailUrl: String?,
    val videoUrl: String?,
    val createdAt: String
)

@Entity(
    tableName = "cached_jobs",
    indices = [Index(value = ["userId", "createdAt"])]
)
data class CachedJobEntity(
    @PrimaryKey val id: String,
    val userId: String,
    val projectId: String,
    val projectTitle: String,
    val jobType: String,
    val status: String,
    val progress: Int,
    val currentStage: String,
    val statusMessage: String,
    val completedStagesCsv: String,
    val retryCount: Int,
    val errorMessage: String?,
    val createdAt: String,
    val updatedAt: String
)

@Entity(
    tableName = "cached_credentials",
    primaryKeys = ["userId", "provider"]
)
data class CachedCredentialEntity(
    val userId: String,
    val provider: String,
    val status: String,
    val maskedKey: String?,
    val lastValidatedAt: String?,
    val lastError: String?,
    val usageSummary: String?,
    val docsUrl: String
)

@Entity(
    tableName = "cached_youtube_channels",
    indices = [Index(value = ["userId"])]
)
data class CachedYouTubeChannelEntity(
    @PrimaryKey val id: String,
    val userId: String,
    val channelId: String,
    val channelName: String,
    val channelHandle: String?,
    val thumbnailUrl: String?,
    val subscriberCount: Long,
    val tokenStatus: String,
    val isDefault: Boolean,
    val connectedAt: String
)

@Entity(
    tableName = "cached_notifications",
    indices = [Index(value = ["userId", "createdAt"])]
)
data class CachedNotificationEntity(
    @PrimaryKey val id: String,
    val userId: String,
    val eventType: String,
    val title: String,
    val body: String,
    val createdAt: String
)
