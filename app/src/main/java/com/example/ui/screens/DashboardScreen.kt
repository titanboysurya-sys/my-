package com.example.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.SmartDisplay
import androidx.compose.material.icons.rounded.Today
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.example.R
import com.example.core.database.CachedJobEntity
import com.example.core.database.CachedNotificationEntity
import com.example.core.database.CachedYouTubeChannelEntity
import com.example.ui.components.StatusPill
import com.example.ui.components.StudioSectionHeader
import com.example.ui.components.TelemetryStatCard
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioAmber
import com.example.ui.theme.StudioEmerald
import com.example.ui.theme.StudioErrorRed
import com.example.ui.viewmodel.StudioUiState

@Composable
fun DashboardScreen(
    uiState: StudioUiState,
    connectedChannel: CachedYouTubeChannelEntity?,
    jobs: List<CachedJobEntity>,
    notifications: List<CachedNotificationEntity>,
    onRefresh: () -> Unit,
    onCreateVideoClick: () -> Unit,
    onToggleAutomation: (Boolean) -> Unit,
    onOpenJobDetail: (String) -> Unit,
    onOpenApiSettings: () -> Unit,
    onOpenYouTubeSettings: () -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("dashboard_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Studio Control Banner
        item {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(172.dp)
                    .clip(MaterialTheme.shapes.large)
            ) {
                Image(
                    painter = painterResource(id = R.drawable.img_studio_hero_banner),
                    contentDescription = stringResource(R.string.cd_studio_hero),
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize()
                )
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            Brush.horizontalGradient(
                                listOf(
                                    Color(0xFF0B0D12).copy(alpha = 0.94f),
                                    Color(0xFF0B0D12).copy(alpha = 0.55f)
                                )
                            )
                        )
                )
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(18.dp),
                    verticalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        StatusPill(
                            status = if (uiState.automationEnabled) "AUTOPILOT ACTIVE" else "AUTOPILOT PAUSED"
                        )
                        IconButton(
                            onClick = onRefresh,
                            modifier = Modifier.testTag("dashboard_refresh_button")
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.Refresh,
                                contentDescription = stringResource(R.string.cd_refresh),
                                tint = Color.White
                            )
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.Bottom
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Creator Control Desk",
                                style = MaterialTheme.typography.headlineMedium,
                                color = Color.White
                            )
                            Text(
                                text = uiState.nextScheduledRun?.let { "Next cloud run: ${it.take(16).replace('T', ' ')} UTC" }
                                    ?: "Cloud workers idle — configure schedule or start a video now",
                                style = MaterialTheme.typography.bodySmall,
                                color = Color(0xFFCBD5E1),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = onCreateVideoClick,
                            modifier = Modifier.testTag("dashboard_generate_video_button"),
                            colors = ButtonDefaults.buttonColors(containerColor = SignalCrimson)
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.AutoAwesome,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Generate")
                        }
                    }
                }
            }
        }

        // Connected YouTube Channel & Quick Autopilot Toggle
        item {
            Card(
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpenYouTubeSettings() }
                            .testTag("dashboard_youtube_channel_row"),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (!connectedChannel?.thumbnailUrl.isNullOrBlank()) {
                            AsyncImage(
                                model = connectedChannel?.thumbnailUrl,
                                contentDescription = stringResource(R.string.cd_youtube_channel),
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .size(44.dp)
                                    .clip(CircleShape)
                            )
                        } else {
                            Box(
                                modifier = Modifier
                                    .size(44.dp)
                                    .clip(CircleShape)
                                    .background(SignalCrimson.copy(alpha = 0.16f)),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.SmartDisplay,
                                    contentDescription = stringResource(R.string.cd_youtube_channel),
                                    tint = SignalCrimson
                                )
                            }
                        }
                        Spacer(modifier = Modifier.width(12.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = connectedChannel?.channelName ?: "Connect YouTube Channel",
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            Text(
                                text = connectedChannel?.let {
                                    "${it.channelHandle ?: it.channelId} • ${it.subscriberCount} subscribers"
                                } ?: "Authorize YouTube Data API v3 for automated publishing",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        StatusPill(status = connectedChannel?.tokenStatus ?: "not_connected")
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Button(
                            onClick = { onToggleAutomation(!uiState.automationEnabled) },
                            modifier = Modifier
                                .weight(1f)
                                .height(48.dp)
                                .testTag("dashboard_toggle_automation_button"),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = if (uiState.automationEnabled)
                                    MaterialTheme.colorScheme.surfaceVariant
                                else StudioEmerald,
                                contentColor = if (uiState.automationEnabled)
                                    MaterialTheme.colorScheme.onSurface
                                else Color(0xFF07130B)
                            )
                        ) {
                            Icon(
                                imageVector = if (uiState.automationEnabled) Icons.Rounded.Pause else Icons.Rounded.PlayArrow,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(if (uiState.automationEnabled) "Pause Autopilot" else "Start Automation")
                        }

                        OutlinedButton(
                            onClick = onOpenApiSettings,
                            modifier = Modifier
                                .height(48.dp)
                                .testTag("dashboard_api_keys_button")
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.Key,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("${uiState.dashboardStats.connectedProvidersCount} Keys")
                        }
                    }
                }
            }
        }

        // 2x2 Telemetry Stats Grid
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    TelemetryStatCard(
                        title = "Today's Jobs",
                        value = uiState.dashboardStats.todayJobs.toString(),
                        icon = Icons.Rounded.Today,
                        accent = PipelineCyan,
                        modifier = Modifier.weight(1f)
                    )
                    TelemetryStatCard(
                        title = "Completed Videos",
                        value = uiState.dashboardStats.completedVideos.toString(),
                        icon = Icons.Rounded.CheckCircle,
                        accent = StudioEmerald,
                        modifier = Modifier.weight(1f)
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    TelemetryStatCard(
                        title = "Scheduled Videos",
                        value = uiState.dashboardStats.scheduledVideos.toString(),
                        icon = Icons.Rounded.Schedule,
                        accent = StudioAmber,
                        modifier = Modifier.weight(1f)
                    )
                    TelemetryStatCard(
                        title = "Failed Jobs",
                        value = uiState.dashboardStats.failedJobs.toString(),
                        icon = Icons.Rounded.ErrorOutline,
                        accent = StudioErrorRed,
                        modifier = Modifier.weight(1f)
                    )
                }
            }
        }

        // Active & Recent Pipeline Jobs
        item {
            StudioSectionHeader(
                title = "Cloud Production Pipeline",
                subtitle = "Tap any job to inspect all 10 production stages"
            )
        }

        if (jobs.isEmpty()) {
            item {
                Card(
                    shape = MaterialTheme.shapes.medium,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            text = "No cloud production jobs yet",
                            style = MaterialTheme.typography.titleMedium
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "Add your Gemini + Pexels/Pixabay keys and launch your first automated video.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        } else {
            items(jobs.take(6), key = { it.id }) { job ->
                JobSummaryCard(job = job, onClick = { onOpenJobDetail(job.id) })
            }
        }

        // Recent Activity Feed
        if (notifications.isNotEmpty()) {
            item {
                StudioSectionHeader(
                    title = "Recent Activity",
                    subtitle = "Cloud worker & YouTube upload events"
                )
            }
            items(notifications.take(5), key = { it.id }) { event ->
                Card(
                    shape = MaterialTheme.shapes.small,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.6f))
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = event.title,
                                style = MaterialTheme.typography.titleSmall
                            )
                            Text(
                                text = event.createdAt.take(16).replace('T', ' '),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = event.body,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun JobSummaryCard(
    job: CachedJobEntity,
    onClick: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .testTag("job_card_${job.id}"),
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = job.projectTitle,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                Spacer(modifier = Modifier.width(8.dp))
                StatusPill(status = job.status)
            }

            LinearProgressIndicator(
                progress = { (job.progress.coerceIn(0, 100)) / 100f },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(6.dp)
                    .clip(MaterialTheme.shapes.small),
                color = when (job.status) {
                    "failed" -> StudioErrorRed
                    "published", "scheduled" -> StudioEmerald
                    else -> PipelineCyan
                },
                trackColor = MaterialTheme.colorScheme.surfaceVariant
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = job.statusMessage.ifBlank { job.currentStage.replace('_', ' ') },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "${job.progress}%",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurface
                )
            }
        }
    }
}
