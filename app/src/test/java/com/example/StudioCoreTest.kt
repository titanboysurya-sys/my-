package com.example

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.example.core.database.AutoTubeDatabase
import com.example.core.database.CachedJobEntity
import com.example.core.database.CachedProjectEntity
import com.example.core.network.DynamicBackendClient
import com.example.core.security.AuthSession
import com.example.core.security.SecureSessionStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class StudioCoreTest {

    private lateinit var context: Context
    private lateinit var db: AutoTubeDatabase

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        db = Room.inMemoryDatabaseBuilder(context, AutoTubeDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun appNameMatchesStudioIdentity() {
        assertEquals("AutoTube Studio", context.getString(R.string.app_name))
    }

    @Test
    fun baseUrlNormalizationHandlesSchemesAndTrailingSlashes() {
        assertEquals(
            "https://autotube.onrender.com/",
            DynamicBackendClient.normalizeBaseUrl("autotube.onrender.com")
        )
        assertEquals(
            "https://autotube.onrender.com/",
            DynamicBackendClient.normalizeBaseUrl("https://autotube.onrender.com///")
        )
    }

    @Test
    fun secureSessionStorePersistsAndClearsAuthSession() {
        val store = SecureSessionStore(context)
        store.clearSession()
        assertNull(store.currentSession())

        val futureExpiry = (System.currentTimeMillis() / 1000L) + 3600L
        val session = AuthSession(
            userId = "user-uuid-1",
            email = "creator@example.com",
            accessToken = "jwt-access-token-value",
            refreshToken = "jwt-refresh-token-value",
            expiresAtEpochSec = futureExpiry
        )
        store.saveSession(session)

        val loaded = store.currentSession()
        assertEquals("user-uuid-1", loaded?.userId)
        assertEquals("creator@example.com", loaded?.email)
        assertFalse(loaded?.isExpired ?: true)

        store.clearSession()
        assertNull(store.currentSession())
    }

    @Test
    fun roomCacheStrictlyIsolatesMultiUserProjectsAndJobs() = runTest {
        db.projectDao().upsertAll(
            listOf(
                CachedProjectEntity(
                    id = "proj-a",
                    userId = "user-a",
                    title = "Owner A History Video",
                    topic = "Roman Concrete",
                    niche = "History",
                    language = "en",
                    format = "9:16",
                    durationSeconds = 60,
                    qualityPreset = "1080p",
                    status = "published",
                    thumbnailUrl = null,
                    videoUrl = null,
                    createdAt = "2026-11-21T10:00:00Z"
                ),
                CachedProjectEntity(
                    id = "proj-b",
                    userId = "user-b",
                    title = "Owner B Science Video",
                    topic = "Quantum Optics",
                    niche = "Science",
                    language = "en",
                    format = "16:9",
                    durationSeconds = 180,
                    qualityPreset = "1080p",
                    status = "queued",
                    thumbnailUrl = null,
                    videoUrl = null,
                    createdAt = "2026-11-21T11:00:00Z"
                )
            )
        )

        db.jobDao().upsert(
            CachedJobEntity(
                id = "job-a",
                userId = "user-a",
                projectId = "proj-a",
                projectTitle = "Owner A History Video",
                jobType = "full_pipeline",
                status = "rendering",
                progress = 74,
                currentStage = "rendering",
                statusMessage = "Encoding H.264",
                completedStagesCsv = "researching,generating_script",
                retryCount = 0,
                errorMessage = null,
                createdAt = "2026-11-21T10:00:00Z",
                updatedAt = "2026-11-21T10:05:00Z"
            )
        )

        val userAProjects = db.projectDao().observeProjects("user-a").first()
        val userBProjects = db.projectDao().observeProjects("user-b").first()
        val userBJobs = db.jobDao().observeJobs("user-b").first()

        assertEquals(1, userAProjects.size)
        assertEquals("proj-a", userAProjects.first().id)
        assertEquals(1, userBProjects.size)
        assertEquals("proj-b", userBProjects.first().id)
        assertTrue(userBJobs.isEmpty())
    }

    @Test
    fun createProjectRequestPreservesCustomScriptMode() {
        val req = com.example.core.network.CreateProjectRequest(
            title = "Custom Story",
            topic = "Custom Story",
            scriptMode = "custom",
            customScript = "Ek samay ek chalaak lomdi thi jo taare gin rahi thi.",
            durationSeconds = 12
        )
        assertEquals("custom", req.scriptMode)
        assertEquals("Ek samay ek chalaak lomdi thi jo taare gin rahi thi.", req.customScript)
    }
}
