package com.example.core.database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface ProjectDao {
    @Query("SELECT * FROM cached_projects WHERE userId = :userId ORDER BY createdAt DESC")
    fun observeProjects(userId: String): Flow<List<CachedProjectEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(items: List<CachedProjectEntity>)

    @Query("DELETE FROM cached_projects WHERE id = :id AND userId = :userId")
    suspend fun deleteById(id: String, userId: String)

    @Query("DELETE FROM cached_projects WHERE userId = :userId")
    suspend fun clearForUser(userId: String)
}

@Dao
interface JobDao {
    @Query("SELECT * FROM cached_jobs WHERE userId = :userId ORDER BY createdAt DESC")
    fun observeJobs(userId: String): Flow<List<CachedJobEntity>>

    @Query("SELECT * FROM cached_jobs WHERE id = :jobId AND userId = :userId LIMIT 1")
    fun observeJobById(jobId: String, userId: String): Flow<CachedJobEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(items: List<CachedJobEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(item: CachedJobEntity)

    @Query("DELETE FROM cached_jobs WHERE userId = :userId")
    suspend fun clearForUser(userId: String)
}

@Dao
interface CredentialDao {
    @Query("SELECT * FROM cached_credentials WHERE userId = :userId ORDER BY provider ASC")
    fun observeCredentials(userId: String): Flow<List<CachedCredentialEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(items: List<CachedCredentialEntity>)

    @Query("DELETE FROM cached_credentials WHERE userId = :userId")
    suspend fun clearForUser(userId: String)
}

@Dao
interface YouTubeChannelDao {
    @Query("SELECT * FROM cached_youtube_channels WHERE userId = :userId ORDER BY isDefault DESC")
    fun observeChannels(userId: String): Flow<List<CachedYouTubeChannelEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(items: List<CachedYouTubeChannelEntity>)

    @Query("DELETE FROM cached_youtube_channels WHERE userId = :userId")
    suspend fun clearForUser(userId: String)
}

@Dao
interface NotificationDao {
    @Query("SELECT * FROM cached_notifications WHERE userId = :userId ORDER BY createdAt DESC LIMIT 30")
    fun observeNotifications(userId: String): Flow<List<CachedNotificationEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(items: List<CachedNotificationEntity>)

    @Query("DELETE FROM cached_notifications WHERE userId = :userId")
    suspend fun clearForUser(userId: String)
}
