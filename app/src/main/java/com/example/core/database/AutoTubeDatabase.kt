package com.example.core.database

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        CachedProjectEntity::class,
        CachedJobEntity::class,
        CachedCredentialEntity::class,
        CachedYouTubeChannelEntity::class,
        CachedNotificationEntity::class
    ],
    version = 1,
    exportSchema = false
)
abstract class AutoTubeDatabase : RoomDatabase() {
    abstract fun projectDao(): ProjectDao
    abstract fun jobDao(): JobDao
    abstract fun credentialDao(): CredentialDao
    abstract fun youTubeChannelDao(): YouTubeChannelDao
    abstract fun notificationDao(): NotificationDao

    companion object {
        @Volatile
        private var instance: AutoTubeDatabase? = null

        fun getInstance(context: Context): AutoTubeDatabase {
            return instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    AutoTubeDatabase::class.java,
                    "autotube_studio_cache.db"
                )
                    .fallbackToDestructiveMigration(true)
                    .build()
                    .also { instance = it }
            }
        }
    }
}
