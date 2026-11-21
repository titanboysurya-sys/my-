package com.example.worker

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.example.AutoTubeApplication
import com.example.R
import java.util.concurrent.TimeUnit

object StudioNotificationManager {
    private const val CHANNEL_ID = "autotube_pipeline_events"

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Video Production & Upload Alerts",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Status alerts for automated script, rendering, YouTube upload, and failures"
            }
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    fun showEventNotification(context: Context, id: Int, title: String, body: String) {
        ensureChannel(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) return
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .build()

        NotificationManagerCompat.from(context).notify(id, notification)
    }
}

/**
 * Local Android WorkManager task for syncing cloud job status & posting Android notifications.
 * Note: Video production itself runs 100% in the Render cloud backend even when the phone is off.
 */
class StudioSyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as? AutoTubeApplication ?: return Result.success()
        val container = app.container
        if (container.sessionStore.currentSession() == null) {
            return Result.success()
        }

        val settings = container.prefsStore.currentSettings()
        if (!settings.notificationsEnabled) {
            return Result.success()
        }

        val result = container.repository.fetchLatestNotifications()
        val latest = result.getOrNull()?.firstOrNull()
        if (latest != null && latest.id != settings.lastNotifiedEventId) {
            StudioNotificationManager.showEventNotification(
                context = applicationContext,
                id = latest.id.hashCode(),
                title = latest.title,
                body = latest.body
            )
            container.prefsStore.setLastNotifiedEventId(latest.id)
        }

        return Result.success()
    }

    companion object {
        private const val UNIQUE_WORK_NAME = "autotube_studio_cloud_sync"

        fun schedulePeriodicSync(context: Context) {
            runCatching {
                val constraints = Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()

                val request = PeriodicWorkRequestBuilder<StudioSyncWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(constraints)
                    .build()

                WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                    UNIQUE_WORK_NAME,
                    ExistingPeriodicWorkPolicy.KEEP,
                    request
                )
            }
        }
    }
}
