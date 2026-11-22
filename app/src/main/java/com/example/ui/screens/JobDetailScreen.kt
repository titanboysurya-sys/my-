package com.example.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Cancel
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.HourglassTop
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Replay
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.core.database.CachedJobEntity
import com.example.ui.components.StatusPill
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioAmber
import com.example.ui.theme.StudioEmerald
import com.example.ui.theme.StudioErrorRed

data class PipelineStageDisplay(
    val key: String,
    val title: String,
    val subtitle: String
)

val TEN_PIPELINE_STAGES = listOf(
    PipelineStageDisplay("researching", "1. Topic Research", "Verify topic & RSS factual references"),
    PipelineStageDisplay("generating_script", "2. Script Generation", "Write duration-calibrated spoken script"),
    PipelineStageDisplay("generating_scenes", "3. Scene Breakdown", "Segment narration & English visual queries"),
    PipelineStageDisplay("searching_media", "4. Media Search", "Score Pexels, Pixabay & Wikimedia candidates"),
    PipelineStageDisplay("downloading_media", "5. Downloads & Dedup", "Verify integrity & upload to Supabase Storage"),
    PipelineStageDisplay("generating_voice", "6. Voice-Over", "Synthesize narration via Gemini TTS / ElevenLabs"),
    PipelineStageDisplay("rendering", "7. FFmpeg Rendering", "Assemble clips, Ken Burns, subtitles & audio mix"),
    PipelineStageDisplay("generating_thumbnail", "8. Thumbnail", "Composite 16:9 high-contrast YouTube thumbnail"),
    PipelineStageDisplay("generating_metadata", "9. Title, Tags & SEO", "Generate accurate title, description & hashtags"),
    PipelineStageDisplay("uploading", "10. YouTube Upload", "Resumable upload & schedule on connected channel")
)

@Composable
fun JobDetailScreen(
    jobId: String,
    job: CachedJobEntity?,
    onRefresh: (String) -> Unit,
    onRetry: (String) -> Unit,
    onCancel: (String) -> Unit,
    onBack: () -> Unit
) {
    LaunchedEffect(jobId) {
        onRefresh(jobId)
    }

    val completedSet = (job?.completedStagesCsv ?: "")
        .split(",")
        .map { it.trim() }
        .filter { it.isNotBlank() }
        .toSet()

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("job_detail_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
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
                        text = job?.projectTitle ?: "Job Pipeline",
                        style = MaterialTheme.typography.titleLarge
                    )
                    Text(
                        text = "Job ID: ${jobId.take(12)}… • Retries: ${job?.retryCount ?: 0}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                IconButton(
                    onClick = { onRefresh(jobId) },
                    modifier = Modifier.testTag("job_detail_refresh_button")
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = stringResource(R.string.cd_refresh))
                }
            }
        }

        // Overall Progress Card
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
                        StatusPill(status = job?.status ?: "queued")
                        Text(
                            text = "${job?.progress ?: 0}%",
                            style = MaterialTheme.typography.headlineSmall,
                            color = PipelineCyan
                        )
                    }

                    LinearProgressIndicator(
                        progress = { ((job?.progress ?: 0).coerceIn(0, 100)) / 100f },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(8.dp)
                            .clip(MaterialTheme.shapes.small),
                        color = when (job?.status) {
                            "failed" -> StudioErrorRed
                            "published", "scheduled" -> StudioEmerald
                            else -> PipelineCyan
                        }
                    )

                    Text(
                        text = job?.statusMessage?.ifBlank { "Waiting for cloud worker..." } ?: "Loading job state...",
                        style = MaterialTheme.typography.bodyMedium
                    )

                    if (!job?.errorMessage.isNullOrBlank()) {
                        Card(
                            colors = CardDefaults.cardColors(containerColor = StudioErrorRed.copy(alpha = 0.14f)),
                            border = BorderStroke(1.dp, StudioErrorRed.copy(alpha = 0.45f))
                        ) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.ErrorOutline,
                                    contentDescription = null,
                                    tint = StudioErrorRed
                                )
                                Spacer(modifier = Modifier.width(10.dp))
                                Text(
                                    text = job?.errorMessage ?: "",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurface
                                )
                            }
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Button(
                            onClick = { onRetry(jobId) },
                            modifier = Modifier
                                .weight(1f)
                                .height(48.dp)
                                .testTag("job_retry_button"),
                            colors = ButtonDefaults.buttonColors(containerColor = SignalCrimson)
                        ) {
                            Icon(Icons.Rounded.Replay, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Retry Stage", maxLines = 1)
                        }
                        OutlinedButton(
                            onClick = { onCancel(jobId) },
                            modifier = Modifier
                                .height(48.dp)
                                .testTag("job_cancel_button")
                        ) {
                            Icon(Icons.Rounded.Cancel, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Cancel", maxLines = 1)
                        }
                    }
                }
            }
        }

        // Visual 10-Stage Pipeline Timeline
        itemsIndexed(TEN_PIPELINE_STAGES) { index, stage ->
            val isCompleted = completedSet.contains(stage.key) ||
                job?.status == "published" ||
                (job?.status == "scheduled" && index < 10)
            val isActive = job?.currentStage == stage.key && !isCompleted && job?.status != "failed"
            val isFailedAtStage = job?.status == "failed" && job.currentStage == stage.key

            val badgeColor = when {
                isFailedAtStage -> StudioErrorRed
                isCompleted -> StudioEmerald
                isActive -> PipelineCyan
                else -> MaterialTheme.colorScheme.outline
            }

            Card(
                shape = MaterialTheme.shapes.small,
                colors = CardDefaults.cardColors(
                    containerColor = if (isActive) MaterialTheme.colorScheme.surfaceVariant
                    else MaterialTheme.colorScheme.surface
                ),
                border = BorderStroke(
                    width = if (isActive || isFailedAtStage) 1.5.dp else 1.dp,
                    color = if (isActive || isFailedAtStage) badgeColor else MaterialTheme.colorScheme.outline.copy(alpha = 0.6f)
                )
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(badgeColor.copy(alpha = if (isCompleted || isActive || isFailedAtStage) 0.22f else 0.1f)),
                        contentAlignment = Alignment.Center
                    ) {
                        when {
                            isFailedAtStage -> Icon(Icons.Rounded.ErrorOutline, contentDescription = "Failed", tint = StudioErrorRed, modifier = Modifier.size(18.dp))
                            isCompleted -> Icon(Icons.Rounded.Check, contentDescription = "Completed", tint = StudioEmerald, modifier = Modifier.size(18.dp))
                            isActive -> Icon(Icons.Rounded.HourglassTop, contentDescription = "Running", tint = PipelineCyan, modifier = Modifier.size(18.dp))
                            else -> Text(
                                text = "${index + 1}",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = stage.title,
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        Text(
                            text = stage.subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Text(
                        text = when {
                            isFailedAtStage -> "FAILED"
                            isCompleted -> "DONE"
                            isActive -> "ACTIVE"
                            else -> "PENDING"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = when {
                            isFailedAtStage -> StudioErrorRed
                            isCompleted -> StudioEmerald
                            isActive -> StudioAmber
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        }
                    )
                }
            }
        }
    }
}
