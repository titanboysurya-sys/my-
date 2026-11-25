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
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.PlayCircleOutline
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import com.example.R
import com.example.core.database.CachedProjectEntity
import com.example.ui.components.StatusPill
import com.example.ui.components.StudioSectionHeader
import com.example.ui.components.downloadVideoWithManager
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioAmber

@Composable
fun ProjectsScreen(
    projects: List<CachedProjectEntity>,
    onRefresh: () -> Unit,
    onCreateNew: () -> Unit,
    onOpenProject: (String) -> Unit,
    onDownloadFeedback: (message: String, isError: Boolean) -> Unit = { _, _ -> }
) {
    val context = LocalContext.current

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("projects_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            StudioSectionHeader(
                title = "Projects Library",
                subtitle = "Watch, download MP4, edit & review videos before pushing to YouTube",
                trailing = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Rounded.Refresh, contentDescription = stringResource(R.string.cd_refresh))
                    }
                }
            )
        }

        if (projects.isEmpty()) {
            item {
                Card(
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Image(
                            painter = painterResource(id = R.drawable.img_empty_projects),
                            contentDescription = stringResource(R.string.cd_empty_projects),
                            contentScale = ContentScale.Crop,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(180.dp)
                                .clip(MaterialTheme.shapes.medium)
                        )
                        Text("No video projects yet", style = MaterialTheme.typography.titleLarge)
                        Text(
                            text = "Generate your first automated video and watch, download MP4, edit voice/subtitles, and review before YouTube upload.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Button(
                            onClick = onCreateNew,
                            colors = ButtonDefaults.buttonColors(containerColor = SignalCrimson)
                        ) {
                            Text("Create First Video")
                        }
                    }
                }
            }
        } else {
            items(projects, key = { it.id }) { project ->
                val hasVideo = !project.videoUrl.isNullOrBlank()
                val needsReview = project.status.equals("ready_for_review", ignoreCase = true)

                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpenProject(project.id) }
                        .testTag("project_card_${project.id}"),
                    shape = MaterialTheme.shapes.medium,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(
                        width = if (needsReview) 1.5.dp else 1.dp,
                        color = if (needsReview) StudioAmber else MaterialTheme.colorScheme.outline
                    )
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier
                                .size(width = 104.dp, height = 68.dp)
                                .clip(MaterialTheme.shapes.small)
                                .background(MaterialTheme.colorScheme.surfaceVariant),
                            contentAlignment = Alignment.Center
                        ) {
                            if (!project.thumbnailUrl.isNullOrBlank()) {
                                AsyncImage(
                                    model = project.thumbnailUrl,
                                    contentDescription = project.title,
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier.fillMaxSize()
                                )
                            } else {
                                Icon(
                                    imageVector = Icons.Rounded.Movie,
                                    contentDescription = null,
                                    tint = PipelineCyan
                                )
                            }
                            if (hasVideo) {
                                Surface(
                                    color = MaterialTheme.colorScheme.scrim.copy(alpha = 0.55f),
                                    shape = MaterialTheme.shapes.small
                                ) {
                                    Icon(
                                        imageVector = Icons.Rounded.PlayCircleOutline,
                                        contentDescription = "Watch video",
                                        tint = MaterialTheme.colorScheme.onPrimary,
                                        modifier = Modifier
                                            .padding(4.dp)
                                            .size(22.dp)
                                    )
                                }
                            }
                        }

                        Spacer(modifier = Modifier.width(12.dp))

                        Column(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            Text(
                                text = project.title,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            Text(
                                text = "${project.niche} • ${project.format} • ${project.durationSeconds}s • ${project.qualityPreset}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                StatusPill(status = project.status)
                                if (hasVideo) {
                                    Text(
                                        text = "MP4 Ready",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = PipelineCyan
                                    )
                                }
                            }
                        }

                        if (hasVideo && project.videoUrl != null) {
                            IconButton(
                                onClick = {
                                    val ok = downloadVideoWithManager(
                                        context = context,
                                        videoUrl = project.videoUrl,
                                        title = project.title
                                    )
                                    if (ok) {
                                        onDownloadFeedback(
                                            "Downloading \"${project.title}\" MP4 to Downloads...",
                                            false
                                        )
                                    } else {
                                        onDownloadFeedback(
                                            "Could not start MP4 download. Open the project to refresh the link.",
                                            true
                                        )
                                    }
                                },
                                modifier = Modifier
                                    .size(48.dp)
                                    .testTag("project_quick_download_${project.id}")
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Download,
                                    contentDescription = "Download MP4 video",
                                    tint = PipelineCyan
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun Media3VideoPlayer(
    videoUrl: String,
    format: String = "16:9"
) {
    val context = LocalContext.current
    val exoPlayer = remember(videoUrl) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(videoUrl))
            prepare()
        }
    }

    DisposableEffect(exoPlayer) {
        onDispose { exoPlayer.release() }
    }

    val playerModifier = when (format) {
        "9:16" -> Modifier
            .fillMaxWidth()
            .heightIn(min = 320.dp, max = 460.dp)
            .clip(MaterialTheme.shapes.small)
        "1:1" -> Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .heightIn(max = 380.dp)
            .clip(MaterialTheme.shapes.small)
        else -> Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(MaterialTheme.shapes.small)
    }

    AndroidView(
        factory = { ctx ->
            PlayerView(ctx).apply {
                player = exoPlayer
                useController = true
            }
        },
        modifier = playerModifier
    )
}
