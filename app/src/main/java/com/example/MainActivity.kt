package com.example

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material.icons.outlined.AutoMode
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.VideoLibrary
import androidx.compose.material.icons.rounded.AddCircle
import androidx.compose.material.icons.rounded.AutoMode
import androidx.compose.material.icons.rounded.Dashboard
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.VideoLibrary
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.example.ui.components.StudioBannerMessage
import com.example.ui.screens.ApiKeysScreen
import com.example.ui.screens.AuthSetupScreen
import com.example.ui.screens.AutomationScreen
import com.example.ui.screens.CreateVideoScreen
import com.example.ui.screens.DashboardScreen
import com.example.ui.screens.JobDetailScreen
import com.example.ui.screens.ProjectDetailScreen
import com.example.ui.screens.ProjectsScreen
import com.example.ui.screens.SettingsScreen
import com.example.ui.screens.YouTubeSettingsScreen
import com.example.ui.theme.AutoTubeStudioTheme
import com.example.ui.viewmodel.StudioViewModel

object StudioRoutes {
    const val DASHBOARD = "dashboard"
    const val CREATE = "create"
    const val AUTOMATION = "automation"
    const val PROJECTS = "projects"
    const val SETTINGS = "settings"
    const val API_KEYS = "api_keys"
    const val YOUTUBE_SETTINGS = "youtube_settings"
    const val PROJECT_DETAIL = "project_detail/{projectId}"
    const val JOB_DETAIL = "job_detail/{jobId}"

    fun projectDetail(id: String) = "project_detail/$id"
    fun jobDetail(id: String) = "job_detail/$id"
}

private data class TopLevelDestination(
    val route: String,
    val label: String,
    val selectedIcon: ImageVector,
    val unselectedIcon: ImageVector
)

private val TOP_DESTINATIONS = listOf(
    TopLevelDestination(StudioRoutes.DASHBOARD, "Dashboard", Icons.Rounded.Dashboard, Icons.Outlined.Dashboard),
    TopLevelDestination(StudioRoutes.CREATE, "Create", Icons.Rounded.AddCircle, Icons.Outlined.AddCircleOutline),
    TopLevelDestination(StudioRoutes.AUTOMATION, "Autopilot", Icons.Rounded.AutoMode, Icons.Outlined.AutoMode),
    TopLevelDestination(StudioRoutes.PROJECTS, "Projects", Icons.Rounded.VideoLibrary, Icons.Outlined.VideoLibrary),
    TopLevelDestination(StudioRoutes.SETTINGS, "Settings", Icons.Rounded.Settings, Icons.Outlined.Settings)
)

class MainActivity : ComponentActivity() {

    private val viewModel: StudioViewModel by viewModels {
        val app = application as AutoTubeApplication
        StudioViewModel.Factory(app.container.repository)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleOAuthIntent(intent)

        setContent {
            val settings by viewModel.appSettings.collectAsStateWithLifecycle()
            AutoTubeStudioTheme(darkTheme = settings.darkTheme) {
                AutoTubeStudioRoot(viewModel = viewModel)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleOAuthIntent(intent)
    }

    private fun handleOAuthIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "autotubestudio" && data.host == "oauth") {
            when {
                data.path?.startsWith("/supabase") == true -> {
                    viewModel.handleSupabaseOAuthDeepLink(data)
                }
                else -> {
                    viewModel.handleYouTubeOAuthDeepLink(
                        status = data.getQueryParameter("status"),
                        channel = data.getQueryParameter("channel"),
                        message = data.getQueryParameter("message")
                    )
                }
            }
        }
    }
}

@Composable
private fun AutoTubeStudioRoot(viewModel: StudioViewModel) {
    val context = LocalContext.current
    val session by viewModel.authSession.collectAsStateWithLifecycle()
    val settings by viewModel.appSettings.collectAsStateWithLifecycle()
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val projects by viewModel.projects.collectAsStateWithLifecycle()
    val jobs by viewModel.jobs.collectAsStateWithLifecycle()
    val credentials by viewModel.credentials.collectAsStateWithLifecycle()
    val channels by viewModel.youtubeChannels.collectAsStateWithLifecycle()
    val notifications by viewModel.notifications.collectAsStateWithLifecycle()

    // Launch Google OAuth 2.0 in AndroidX Custom Tabs (with default browser fallback)
    LaunchedEffect(uiState.pendingOAuthUrl) {
        val url = uiState.pendingOAuthUrl ?: return@LaunchedEffect
        viewModel.consumePendingOAuthUrl()
        val uri = Uri.parse(url)
        val launchedCustomTab = runCatching {
            CustomTabsIntent.Builder().build().launchUrl(context, uri)
        }.isSuccess
        if (!launchedCustomTab) {
            val launchedBrowser = runCatching {
                context.startActivity(
                    Intent(Intent.ACTION_VIEW, uri).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                )
            }.isSuccess
            if (!launchedBrowser) {
                viewModel.reportExternalError(
                    "Could not open a browser for Google sign-in. Ensure Chrome or a web browser is installed."
                )
            }
        }
    }

    if (session == null) {
        Scaffold(
            contentWindowInsets = WindowInsets.safeDrawing,
            containerColor = MaterialTheme.colorScheme.background
        ) { innerPadding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
            ) {
                uiState.bannerMessage?.let { msg ->
                    StudioBannerMessage(
                        message = msg,
                        isError = uiState.isErrorBanner,
                        onDismiss = viewModel::dismissBanner
                    )
                }
                AuthSetupScreen(
                    settings = settings,
                    uiState = uiState,
                    onCheckHealth = viewModel::checkServerHealth,
                    onSignInWithGoogleIdToken = viewModel::signInWithGoogleIdToken,
                    onLaunchGoogleBrowserSignIn = viewModel::launchSupabaseGoogleOAuth,
                    onSignIn = viewModel::signIn,
                    onSignUp = viewModel::signUp
                )
            }
        }
        return
    }

    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val isTopLevel = TOP_DESTINATIONS.any { it.route == currentRoute }

    // Navigate directly to Job Timeline when a new production job starts
    LaunchedEffect(uiState.lastCreatedJobId) {
        val createdJobId = uiState.lastCreatedJobId ?: return@LaunchedEffect
        viewModel.consumeLastCreatedJobId()
        navController.navigate(StudioRoutes.jobDetail(createdJobId))
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val useNavRail = maxWidth >= 600.dp

        Scaffold(
            contentWindowInsets = WindowInsets.safeDrawing,
            containerColor = MaterialTheme.colorScheme.background,
            bottomBar = {
                if (isTopLevel && !useNavRail) {
                    NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                        TOP_DESTINATIONS.forEach { dest ->
                            val selected = currentRoute == dest.route
                            NavigationBarItem(
                                selected = selected,
                                onClick = {
                                    navController.navigate(dest.route) {
                                        popUpTo(StudioRoutes.DASHBOARD) { saveState = true }
                                        launchSingleTop = true
                                        restoreState = true
                                    }
                                },
                                icon = {
                                    Icon(
                                        imageVector = if (selected) dest.selectedIcon else dest.unselectedIcon,
                                        contentDescription = dest.label
                                    )
                                },
                                label = { Text(dest.label, maxLines = 1) },
                                modifier = Modifier.testTag("nav_${dest.route}")
                            )
                        }
                    }
                }
            }
        ) { innerPadding ->
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
            ) {
                if (isTopLevel && useNavRail) {
                    NavigationRail(
                        modifier = Modifier.fillMaxHeight(),
                        containerColor = MaterialTheme.colorScheme.surface
                    ) {
                        TOP_DESTINATIONS.forEach { dest ->
                            val selected = currentRoute == dest.route
                            NavigationRailItem(
                                selected = selected,
                                onClick = {
                                    navController.navigate(dest.route) {
                                        popUpTo(StudioRoutes.DASHBOARD) { saveState = true }
                                        launchSingleTop = true
                                        restoreState = true
                                    }
                                },
                                icon = {
                                    Icon(
                                        imageVector = if (selected) dest.selectedIcon else dest.unselectedIcon,
                                        contentDescription = dest.label
                                    )
                                },
                                label = { Text(dest.label) }
                            )
                        }
                    }
                }

                Column(modifier = Modifier.weight(1f)) {
                    uiState.bannerMessage?.let { msg ->
                        StudioBannerMessage(
                            message = msg,
                            isError = uiState.isErrorBanner,
                            onDismiss = viewModel::dismissBanner
                        )
                    }

                    Box(modifier = Modifier.weight(1f)) {
                        NavHost(
                            navController = navController,
                            startDestination = StudioRoutes.DASHBOARD
                        ) {
                            composable(StudioRoutes.DASHBOARD) {
                                DashboardScreen(
                                    uiState = uiState,
                                    connectedChannel = channels.firstOrNull { it.isDefault } ?: channels.firstOrNull(),
                                    jobs = jobs,
                                    notifications = notifications,
                                    onRefresh = viewModel::refreshAllStudioData,
                                    onCreateVideoClick = { navController.navigate(StudioRoutes.CREATE) },
                                    onToggleAutomation = viewModel::toggleAutomation,
                                    onOpenJobDetail = { jobId ->
                                        navController.navigate(StudioRoutes.jobDetail(jobId))
                                    },
                                    onOpenApiSettings = { navController.navigate(StudioRoutes.API_KEYS) },
                                    onOpenYouTubeSettings = { navController.navigate(StudioRoutes.YOUTUBE_SETTINGS) }
                                )
                            }

                            composable(StudioRoutes.CREATE) {
                                CreateVideoScreen(
                                    settings = settings,
                                    uiState = uiState,
                                    onResearchTopics = viewModel::researchTopics,
                                    onGenerateVideo = viewModel::createProjectAndGenerate
                                )
                            }

                            composable(StudioRoutes.AUTOMATION) {
                                AutomationScreen(
                                    uiState = uiState,
                                    onSaveSchedule = viewModel::saveAutomationSettings,
                                    onToggleAutomation = viewModel::toggleAutomation,
                                    onGenerateNow = viewModel::createProjectAndGenerate
                                )
                            }

                            composable(StudioRoutes.PROJECTS) {
                                ProjectsScreen(
                                    projects = projects,
                                    onRefresh = viewModel::refreshProjects,
                                    onCreateNew = { navController.navigate(StudioRoutes.CREATE) },
                                    onOpenProject = { id ->
                                        navController.navigate(StudioRoutes.projectDetail(id))
                                    }
                                )
                            }

                            composable(StudioRoutes.SETTINGS) {
                                SettingsScreen(
                                    session = session,
                                    settings = settings,
                                    connectedKeysCount = credentials.count { it.status == "connected" },
                                    connectedChannelName = channels.firstOrNull()?.channelName,
                                    onOpenApiKeys = { navController.navigate(StudioRoutes.API_KEYS) },
                                    onOpenYouTubeSettings = { navController.navigate(StudioRoutes.YOUTUBE_SETTINGS) },
                                    onSaveEndpoints = viewModel::saveCloudEndpoints,
                                    onCheckHealth = viewModel::checkServerHealth,
                                    onUpdateTheme = { dark -> viewModel.updateAppPreferences(darkTheme = dark) },
                                    onUpdateDefaults = { lang, fmt, q ->
                                        viewModel.updateAppPreferences(
                                            language = lang,
                                            defaultFormat = fmt,
                                            defaultQuality = q
                                        )
                                    },
                                    onToggleNotifications = { enabled ->
                                        viewModel.updateAppPreferences(notificationsEnabled = enabled)
                                    },
                                    onClearCache = viewModel::clearLocalCache,
                                    onSignOut = viewModel::signOut,
                                    onDeleteAccount = viewModel::deleteAccount
                                )
                            }

                            composable(StudioRoutes.API_KEYS) {
                                ApiKeysScreen(
                                    settings = settings,
                                    credentials = credentials,
                                    uiState = uiState,
                                    onRefresh = viewModel::refreshCredentials,
                                    onValidateKey = viewModel::validateApiKey,
                                    onSaveKey = viewModel::saveApiKey,
                                    onRemoveKey = viewModel::removeApiKey,
                                    onUpdateProviderRouting = viewModel::updateProviderRouting,
                                    onBack = { navController.popBackStack() }
                                )
                            }

                            composable(StudioRoutes.YOUTUBE_SETTINGS) {
                                YouTubeSettingsScreen(
                                    channels = channels,
                                    isLoading = uiState.isLoading,
                                    onRefresh = { viewModel.refreshYouTubeAccounts(showFeedback = false) },
                                    onManualRefresh = { viewModel.refreshYouTubeAccounts(showFeedback = true) },
                                    onConnectYouTube = viewModel::initiateYouTubeConnect,
                                    onDisconnectYouTube = viewModel::disconnectYouTube,
                                    onBack = { navController.popBackStack() }
                                )
                            }

                            composable(
                                route = StudioRoutes.PROJECT_DETAIL,
                                arguments = listOf(navArgument("projectId") { type = NavType.StringType })
                            ) { entry ->
                                val pid = entry.arguments?.getString("projectId") ?: return@composable
                                ProjectDetailScreen(
                                    projectId = pid,
                                    uiState = uiState,
                                    onLoadDetail = viewModel::loadProjectDetail,
                                    onSaveScript = viewModel::saveProjectScript,
                                    onRegenerateScript = viewModel::regenerateProjectScript,
                                    onOpenJobDetail = { jobId ->
                                        navController.navigate(StudioRoutes.jobDetail(jobId))
                                    },
                                    onDeleteProject = viewModel::deleteProject,
                                    onBack = { navController.popBackStack() }
                                )
                            }

                            composable(
                                route = StudioRoutes.JOB_DETAIL,
                                arguments = listOf(navArgument("jobId") { type = NavType.StringType })
                            ) { entry ->
                                val jid = entry.arguments?.getString("jobId") ?: return@composable
                                val job by viewModel.observeJob(jid).collectAsStateWithLifecycle(initialValue = null)
                                JobDetailScreen(
                                    jobId = jid,
                                    job = job,
                                    onRefresh = viewModel::refreshJobDetail,
                                    onRetry = viewModel::retryJob,
                                    onCancel = viewModel::cancelJob,
                                    onBack = { navController.popBackStack() }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
