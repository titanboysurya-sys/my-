package com.example

import android.app.Application
import com.example.core.database.AutoTubeDatabase
import com.example.core.datastore.StudioPreferencesStore
import com.example.core.network.DynamicBackendClient
import com.example.core.security.SecureSessionStore
import com.example.data.StudioRepository
import com.example.worker.StudioNotificationManager
import com.example.worker.StudioSyncWorker

class AppContainer(application: Application) {
    val prefsStore = StudioPreferencesStore(application)
    val sessionStore = SecureSessionStore(application)
    val database = AutoTubeDatabase.getInstance(application)
    val networkClient = DynamicBackendClient(prefsStore, sessionStore)
    val repository = StudioRepository(database, networkClient, sessionStore, prefsStore)
}

class AutoTubeApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        StudioNotificationManager.ensureChannel(this)
        StudioSyncWorker.schedulePeriodicSync(this)
    }
}
