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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Save
import androidx.compose.material.icons.rounded.Timeline
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioEmerald
import com.example.ui.viewmodel.StudioUiState

@Composable
fun ProjectsScreen(
    projects: List<CachedProjectEntity>,
    onRefresh: () -> Unit,
    onCreateNew: () -> Unit,
    onOpenProject: (String) -> Unit
) {
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
                subtitle = "Scripts, scenes, thumbnails & rendered MP4 videos",
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
                            text = "Generate your first automated video and inspect scripts, scenes, thumbnails, and MP4 previews here.",
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
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpenProject(project.id) }
                        .testTag("project_card_${project.id}"),
                    shape = MaterialTheme.shapes.medium,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (!project.thumbnailUrl.isNullOrBlank()) {
                            AsyncImage(
                                model = project.thumbnailUrl,
                                contentDescription = project.title,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .size(width = 104.dp, height = 66.dp)
                                    .clip(MaterialTheme.shapes.small)
                            )
                        } else {
                            Box(
                                modifier = Modifier
                                    .size(width = 104.dp, height = 66.dp)
                                    .clip(MaterialTheme.shapes.small)
                                    .background(MaterialTheme.colorScheme.surfaceVariant),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Movie,
                                    contentDescription = null,
                                    tint = PipelineCyan
                                )
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
                            StatusPill(status = project.status)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ProjectDetailScreen(
    projectId: String,
    uiState: StudioUiState,
    onLoadDetail: (String) -> Unit,
    onSaveScript: (projectId: String, narration: String, titleIdea: String?, approveAndContinue: Boolean) -> Unit,
    onRegenerateScript: (projectId: String, tone: String, durationSeconds: Int) -> Unit,
    onOpenJobDetail: (String) -> Unit,
    onDeleteProject: (String) -> Unit,
    onBack: () -> Unit
) {
    LaunchedEffect(projectId) {
        onLoadDetail(projectId)
    }

    val detail = uiState.selectedProjectDetail
    val latestScript = detail?.scripts?.firstOrNull()
    var scriptText by remember(latestScript?.id) {
        mutableStateOf(latestScript?.narrationText ?: latestScript?.scriptText ?: "")
    }
    var tone by remember { mutableStateOf("engaging") }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("project_detail_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = stringResource(R.string.cd_back))
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = detail?.project?.title ?: "Project Details",
                        style = MaterialTheme.typography.titleLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    detail?.project?.let {
                        Text(
                            text = "${it.niche} • ${it.format} • ${it.durationSeconds}s • ${it.language.uppercase()}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                IconButton(
                    onClick = {
                        onDeleteProject(projectId)
                        onBack()
                    }
                ) {
                    Icon(
                        imageVector = Icons.Rounded.DeleteOutline,
                        contentDescription = "Delete project",
                        tint = MaterialTheme.colorScheme.error
                    )
                }
            }
        }

        if (uiState.isLoadingProjectDetail && detail == null) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(32.dp),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            }
        } else if (detail != null) {
            // Media3 ExoPlayer Preview when final rendered MP4 signed URL is available
            if (!detail.project.videoSignedUrl.isNullOrBlank()) {
                item {
                    Card(
                        shape = MaterialTheme.shapes.medium,
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text("Rendered Video Preview (Media3)", style = MaterialTheme.typography.titleMedium)
                            Spacer(modifier = Modifier.height(8.dp))
                            Media3VideoPlayer(videoUrl = detail.project.videoSignedUrl)
                        }
                    }
                }
            } else if (!detail.project.thumbnailSignedUrl.isNullOrBlank()) {
                item {
                    AsyncImage(
                        model = detail.project.thumbnailSignedUrl,
                        contentDescription = detail.project.title,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .fillMaxWidth()
                            .aspectRatio(16f / 9f)
                            .clip(MaterialTheme.shapes.medium)
                    )
                }
            }

            // Link to Active Pipeline Job Timeline
            detail.jobs.firstOrNull()?.let { latestJob ->
                item {
                    OutlinedButton(
                        onClick = { onOpenJobDetail(latestJob.id) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                            .testTag("project_open_job_timeline_button")
                    ) {
                        Icon(Icons.Rounded.Timeline, contentDescription = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Inspect 10-Stage Job Timeline (${latestJob.progress}%)")
                    }
                }
            }

            // Script Editor Card
            item {
                Card(
                    shape = MaterialTheme.shapes.medium,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "Script Editor (v${latestScript?.version ?: 1})",
                                style = MaterialTheme.typography.titleMedium
                            )
                            Text(
                                text = "${scriptText.trim().split(Regex("\\s+")).filter { it.isNotBlank() }.size} words",
                                style = MaterialTheme.typography.labelMedium,
                                color = PipelineCyan
                            )
                        }

                        OutlinedTextField(
                            value = scriptText,
                            onValueChange = { scriptText = it },
                            label = { Text("Spoken Narration Script") },
                            minLines = 6,
                            maxLines = 14,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("script_editor_input")
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            OutlinedButton(
                                onClick = {
                                    onSaveScript(projectId, scriptText, detail.project.title, false)
                                },
                                modifier = Modifier
                                    .weight(1f)
                                    .height(48.dp)
                                    .testTag("script_save_button")
                            ) {
                                Icon(Icons.Rounded.Save, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("Save")
                            }
                            OutlinedButton(
                                onClick = {
                                    onRegenerateScript(projectId, tone, detail.project.durationSeconds)
                                },
                                modifier = Modifier
                                    .weight(1f)
                                    .height(48.dp)
                                    .testTag("script_regenerate_button")
                            ) {
                                Icon(Icons.Rounded.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("Regenerate")
                            }
                        }

                        Button(
                            onClick = {
                                onSaveScript(projectId, scriptText, detail.project.title, true)
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(48.dp)
                                .testTag("script_approve_continue_button"),
                            colors = ButtonDefaults.buttonColors(containerColor = StudioEmerald)
                        ) {
                            Icon(Icons.Rounded.CheckCircle, contentDescription = null)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Approve Script & Continue Production")
                        }
                    }
                }
            }

            // Scene Breakdown Viewer
            if (detail.scenes.isNotEmpty()) {
                item {
                    StudioSectionHeader(
                        title = "Scene Breakdown (${detail.scenes.size})",
                        subtitle = "Visual descriptions & stock footage search queries"
                    )
                }
                items(detail.scenes, key = { it.id }) { scene ->
                    Card(
                        shape = MaterialTheme.shapes.small,
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.7f))
                    ) {
                        Column(
                            modifier = Modifier.padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(
                                    text = "Scene ${scene.sceneNumber} (${scene.duration}s)",
                                    style = MaterialTheme.typography.titleSmall
                                )
                                StatusPill(status = if (scene.fallbackUsed) "fallback_image" else scene.status)
                            }
                            Text(text = scene.narration, style = MaterialTheme.typography.bodySmall)
                            Text(
                                text = "Visual: ${scene.visualDescription}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Text(
                                text = "Query: ${scene.primaryKeyword}",
                                style = MaterialTheme.typography.labelSmall,
                                color = PipelineCyan
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun Media3VideoPlayer(videoUrl: String) {
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

    AndroidView(
        factory = { ctx ->
            PlayerView(ctx).apply {
                player = exoPlayer
                useController = true
            }
        },
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(MaterialTheme.shapes.small)
    )
}
