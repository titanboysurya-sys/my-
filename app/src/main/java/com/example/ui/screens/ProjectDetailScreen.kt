package com.example.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.rounded.AutoFixHigh
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CloudUpload
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Save
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.SmartDisplay
import androidx.compose.material.icons.rounded.Timeline
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.example.R
import com.example.core.database.CachedYouTubeChannelEntity
import com.example.core.network.PublishProjectRequest
import com.example.core.network.RerenderProjectRequest
import com.example.core.network.SceneOverrideRequest
import com.example.core.network.UpdateProjectSettingsRequest
import com.example.ui.components.MediaSourceAndLinksSection
import com.example.ui.components.StatusPill
import com.example.ui.components.StudioSectionHeader
import com.example.ui.components.StudioTimePickerDialog
import com.example.ui.components.SubtitleStyleSelectorSection
import com.example.ui.components.ViralProductionControlsSection
import com.example.ui.components.VoiceSelectorSection
import com.example.ui.components.buildUtcIsoFromLocalDateTime
import com.example.ui.components.downloadVideoWithManager
import com.example.ui.components.format24hTo12hDisplay
import com.example.ui.components.formatHourMinute24
import com.example.ui.components.formatIsoToLocalDisplay
import com.example.ui.components.formatLocalDateSummary
import com.example.ui.components.parseCustomMediaLinks
import com.example.ui.components.shareVideoLink
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioAmber
import com.example.ui.theme.StudioEmerald
import com.example.ui.viewmodel.StudioUiState
import com.example.ui.viewmodel.VoiceSettingsUiState
import java.util.Calendar
import java.util.TimeZone

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
fun ProjectDetailScreen(
    projectId: String,
    uiState: StudioUiState,
    voiceState: VoiceSettingsUiState = VoiceSettingsUiState(),
    channels: List<CachedYouTubeChannelEntity> = emptyList(),
    onLoadDetail: (String) -> Unit,
    onSaveScript: (projectId: String, narration: String, titleIdea: String?, approveAndContinue: Boolean) -> Unit,
    onRegenerateScript: (projectId: String, tone: String, durationSeconds: Int) -> Unit,
    onSaveSettingsAndRerender: (
        projectId: String,
        settingsRequest: UpdateProjectSettingsRequest,
        rerenderRequest: RerenderProjectRequest?
    ) -> Unit,
    onPublishProject: (projectId: String, request: PublishProjectRequest) -> Unit,
    onPreviewVoice: (voiceId: String, provider: String, language: String, speed: Double) -> Unit = { _, _, _, _ -> },
    onStopVoicePreview: () -> Unit = {},
    onOpenVoiceStudio: () -> Unit = {},
    onNotifyUser: (message: String, isError: Boolean) -> Unit,
    onOpenJobDetail: (String) -> Unit,
    onDeleteProject: (String) -> Unit,
    onBack: () -> Unit
) {
    val context = LocalContext.current

    LaunchedEffect(projectId) {
        onLoadDetail(projectId)
    }

    val detail = uiState.selectedProjectDetail?.takeIf { it.project.id == projectId }
    val project = detail?.project
    val latestScript = detail?.scripts?.firstOrNull()

    // Script editor state
    var scriptText by remember(latestScript?.id) {
        mutableStateOf(latestScript?.narrationText ?: latestScript?.scriptText ?: "")
    }
    var tone by remember { mutableStateOf("engaging") }

    // YouTube review & publish metadata state
    val seoMap = project?.seoMetadata.orEmpty()
    val uploadMap = project?.uploadConfig.orEmpty()
    val subMap = project?.subtitleStyle.orEmpty()

    var publishTitle by remember(project?.id, project?.title) {
        mutableStateOf((seoMap["title"] as? String)?.ifBlank { project?.title } ?: project?.title ?: "")
    }
    var publishDescription by remember(project?.id, seoMap["description"]) {
        mutableStateOf(seoMap["description"]?.toString().orEmpty())
    }
    var publishTagsCsv by remember(project?.id, seoMap["tags"]) {
        val list = (seoMap["tags"] as? List<*>)?.mapNotNull { it?.toString() }.orEmpty()
        mutableStateOf(list.joinToString(", "))
    }
    var publishPrivacy by remember(project?.id, uploadMap["privacy_status"]) {
        mutableStateOf(uploadMap["privacy_status"]?.toString()?.ifBlank { "private" } ?: "private")
    }
    var selectedChannelId by remember(project?.id, channels) {
        val existingCh = uploadMap["youtube_account_id"]?.toString()?.takeIf { it.isNotBlank() }
        mutableStateOf(
            existingCh ?: channels.firstOrNull { it.isDefault }?.id ?: channels.firstOrNull()?.id
        )
    }
    var schedulePublishLater by remember(project?.id) { mutableStateOf(false) }

    val initialScheduleCal = remember {
        Calendar.getInstance().apply {
            add(Calendar.HOUR_OF_DAY, 2)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
    }
    val initialUtcDateMillis = remember {
        Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            set(Calendar.YEAR, initialScheduleCal.get(Calendar.YEAR))
            set(Calendar.MONTH, initialScheduleCal.get(Calendar.MONTH))
            set(Calendar.DAY_OF_MONTH, initialScheduleCal.get(Calendar.DAY_OF_MONTH))
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis
    }
    var scheduledDateMillis by remember { mutableLongStateOf(initialUtcDateMillis) }
    var scheduledHour by remember { mutableIntStateOf(initialScheduleCal.get(Calendar.HOUR_OF_DAY)) }
    var scheduledMinute by remember { mutableIntStateOf(initialScheduleCal.get(Calendar.MINUTE)) }
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }

    // Voice, Subtitles & Open-Source Media settings state
    var editVoiceProvider by remember(project?.id, project?.voiceProvider) {
        mutableStateOf(project?.voiceProvider ?: "gemini_tts")
    }
    var editVoiceId by remember(project?.id, project?.voiceId) {
        mutableStateOf(project?.voiceId?.ifBlank { "Charon" } ?: "Charon")
    }
    var editVoiceSpeed by remember(project?.id, project?.voiceSpeed) {
        mutableStateOf(project?.voiceSpeed ?: 1.0)
    }
    var editSubtitlesEnabled by remember(project?.id, subMap["enabled"]) {
        mutableStateOf(subMap["enabled"] as? Boolean ?: true)
    }
    var editSubtitlePreset by remember(project?.id, subMap["preset"]) {
        mutableStateOf(subMap["preset"]?.toString()?.ifBlank { "mrbeast" } ?: "mrbeast")
    }
    var editSubtitlePosition by remember(project?.id, subMap["position"]) {
        mutableStateOf(subMap["position"]?.toString()?.ifBlank { "bottom_safe" } ?: "bottom_safe")
    }
    var editMediaSourceMode by remember(project?.id, uploadMap["media_source_mode"]) {
        mutableStateOf(uploadMap["media_source_mode"]?.toString()?.ifBlank { "all" } ?: "all")
    }
    var editCustomLinksText by remember(project?.id, uploadMap["custom_media_urls"]) {
        val urls = (uploadMap["custom_media_urls"] as? List<*>)?.mapNotNull { it?.toString() }.orEmpty()
        mutableStateOf(urls.joinToString("\n"))
    }
    var editEditingPace by remember(project?.id, uploadMap["editing_pace"]) {
        mutableStateOf(uploadMap["editing_pace"]?.toString()?.ifBlank { "viral_fast" } ?: "viral_fast")
    }
    var editBgmMood by remember(project?.id, uploadMap["bgm_mood"]) {
        mutableStateOf(uploadMap["bgm_mood"]?.toString()?.ifBlank { "auto" } ?: "auto")
    }
    var editSfxEnabled by remember(project?.id, uploadMap["sfx_enabled"]) {
        mutableStateOf(uploadMap["sfx_enabled"] as? Boolean ?: true)
    }
    var editColorGrade by remember(project?.id, uploadMap["color_grade"]) {
        mutableStateOf(uploadMap["color_grade"]?.toString()?.ifBlank { "vibrant" } ?: "vibrant")
    }
    var editWhisperSync by remember(project?.id, uploadMap["whisper_sync"]) {
        mutableStateOf(uploadMap["whisper_sync"] as? Boolean ?: true)
    }
    var editHookBannerEnabled by remember(project?.id, uploadMap["hook_banner"]) {
        mutableStateOf(uploadMap["hook_banner"] as? Boolean ?: true)
    }
    var regenerateVoiceOnRerender by remember { mutableStateOf(true) }
    var refetchMediaOnRerender by remember { mutableStateOf(false) }
    var expandCreativeStudio by remember(project?.id, project?.status) {
        mutableStateOf(project?.status == "ready_for_review")
    }

    // Per-scene keyword & custom open-source URL overrides
    val sceneKeywordsMap = remember(project?.id, detail?.scenes?.size) {
        mutableStateMapOf<String, String>().apply {
            detail?.scenes?.forEach { sc -> this[sc.id] = sc.primaryKeyword }
        }
    }
    val sceneCustomUrlMap = remember(project?.id, detail?.scenes?.size) {
        mutableStateMapOf<String, String>().apply {
            detail?.scenes?.forEach { sc ->
                val existingUrl = sc.searchKeywords
                    .firstOrNull { it.startsWith("custom_url:") }
                    ?.removePrefix("custom_url:")
                    .orEmpty()
                this[sc.id] = existingUrl
            }
        }
    }

    val computedPublishAtIso = if (schedulePublishLater) {
        buildUtcIsoFromLocalDateTime(scheduledDateMillis, scheduledHour, scheduledMinute)
    } else null

    if (showDatePicker) {
        val datePickerState = rememberDatePickerState(initialSelectedDateMillis = scheduledDateMillis)
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    datePickerState.selectedDateMillis?.let { scheduledDateMillis = it }
                    showDatePicker = false
                }) { Text("Confirm") }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) { Text("Cancel") }
            }
        ) {
            DatePicker(state = datePickerState)
        }
    }

    if (showTimePicker) {
        StudioTimePickerDialog(
            title = "Schedule YouTube Publish Time",
            initialHour = scheduledHour,
            initialMinute = scheduledMinute,
            onDismiss = { showTimePicker = false },
            onConfirm = { h, m ->
                scheduledHour = h
                scheduledMinute = m
                showTimePicker = false
            }
        )
    }

    fun buildSettingsPayload(): UpdateProjectSettingsRequest {
        val sceneOverrides = detail?.scenes?.map { sc ->
            SceneOverrideRequest(
                sceneId = sc.id,
                primaryKeyword = sceneKeywordsMap[sc.id]?.trim()?.takeIf { it.isNotBlank() },
                customMediaUrl = sceneCustomUrlMap[sc.id]?.trim()?.takeIf { it.startsWith("https://", ignoreCase = true) }
            )
        }
        return UpdateProjectSettingsRequest(
            title = publishTitle.trim().takeIf { it.isNotBlank() },
            description = publishDescription.trim(),
            tags = publishTagsCsv.split(",").map { it.trim() }.filter { it.isNotBlank() }.take(25),
            voiceProvider = editVoiceProvider,
            voiceId = editVoiceId,
            voiceSpeed = editVoiceSpeed,
            subtitlePreset = editSubtitlePreset,
            subtitlePosition = editSubtitlePosition,
            subtitlesEnabled = editSubtitlesEnabled,
            mediaSourceMode = editMediaSourceMode,
            customMediaUrls = parseCustomMediaLinks(editCustomLinksText),
            sceneOverrides = sceneOverrides,
            editingPace = editEditingPace,
            bgmMood = editBgmMood,
            sfxEnabled = editSfxEnabled,
            colorGrade = editColorGrade,
            whisperSync = editWhisperSync,
            hookBannerEnabled = editHookBannerEnabled
        )
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("project_detail_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Header Row
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
                        text = project?.title ?: "Project Details",
                        style = MaterialTheme.typography.titleLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    project?.let {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(
                                text = "${it.niche} • ${it.format} • ${it.durationSeconds}s • ${it.voiceId}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false)
                            )
                            StatusPill(status = it.status)
                        }
                    }
                }
                IconButton(
                    onClick = { onLoadDetail(projectId) }
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "Refresh project")
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
        } else if (detail != null && project != null) {
            // 1. Rendered MP4 Player + Download MP4 / Share Actions
            if (!project.videoSignedUrl.isNullOrBlank()) {
                item {
                    Card(
                        shape = MaterialTheme.shapes.medium,
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                        border = BorderStroke(
                            1.dp,
                            if (project.status == "ready_for_review") StudioAmber else MaterialTheme.colorScheme.outline
                        )
                    ) {
                        Column(
                            modifier = Modifier.padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text("Rendered Video Preview", style = MaterialTheme.typography.titleMedium)
                                StatusPill(status = project.status)
                            }

                            Media3VideoPlayer(
                                videoUrl = project.videoSignedUrl,
                                format = project.format
                            )

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Button(
                                    onClick = {
                                        val ok = downloadVideoWithManager(
                                            context = context,
                                            videoUrl = project.videoSignedUrl,
                                            title = project.title
                                        )
                                        if (ok) {
                                            onNotifyUser("Downloading MP4 to your phone's Downloads folder...", false)
                                        } else {
                                            onNotifyUser("Could not start MP4 download. Check network and retry.", true)
                                        }
                                    },
                                    modifier = Modifier
                                        .weight(1.3f)
                                        .height(48.dp)
                                        .testTag("project_download_mp4_button"),
                                    colors = ButtonDefaults.buttonColors(containerColor = PipelineCyan)
                                ) {
                                    Icon(Icons.Rounded.Download, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text("Download MP4", fontWeight = FontWeight.SemiBold)
                                }

                                OutlinedButton(
                                    onClick = {
                                        shareVideoLink(context, project.videoSignedUrl, project.title)
                                    },
                                    modifier = Modifier
                                        .weight(0.9f)
                                        .height(48.dp)
                                        .testTag("project_share_video_button")
                                ) {
                                    Icon(Icons.Rounded.Share, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text("Share")
                                }
                            }
                        }
                    }
                }

                // 2. Final Pre-YouTube Review & Direct Publish Card
                item {
                    val isAwaitingReview = project.status == "ready_for_review"
                    Card(
                        shape = MaterialTheme.shapes.medium,
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                        border = BorderStroke(
                            width = if (isAwaitingReview) 1.5.dp else 1.dp,
                            color = if (isAwaitingReview) StudioEmerald else MaterialTheme.colorScheme.outline
                        )
                    ) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    imageVector = Icons.Rounded.CloudUpload,
                                    contentDescription = null,
                                    tint = if (isAwaitingReview) StudioEmerald else SignalCrimson
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = if (isAwaitingReview)
                                            "Final Review & Approve for YouTube"
                                        else
                                            "Push Rendered Video to YouTube",
                                        style = MaterialTheme.typography.titleMedium
                                    )
                                    Text(
                                        text = if (isAwaitingReview)
                                            "Watch the preview above. Edit title/tags or customize voice & subtitles below before pushing live."
                                        else
                                            "Uploads your already-rendered MP4 directly to YouTube without re-rendering.",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }

                            OutlinedTextField(
                                value = publishTitle,
                                onValueChange = { publishTitle = it },
                                label = { Text("YouTube Video Title") },
                                singleLine = true,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .testTag("publish_title_input")
                            )

                            OutlinedTextField(
                                value = publishDescription,
                                onValueChange = { publishDescription = it },
                                label = { Text("YouTube Description") },
                                minLines = 2,
                                maxLines = 4,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .testTag("publish_description_input")
                            )

                            OutlinedTextField(
                                value = publishTagsCsv,
                                onValueChange = { publishTagsCsv = it },
                                label = { Text("Tags (comma-separated)") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )

                            if (channels.isNotEmpty()) {
                                Text("Target YouTube Channel", style = MaterialTheme.typography.labelLarge)
                                FlowRow(
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalArrangement = Arrangement.spacedBy(6.dp)
                                ) {
                                    channels.forEach { ch ->
                                        FilterChip(
                                            selected = selectedChannelId == ch.id,
                                            onClick = { selectedChannelId = ch.id },
                                            leadingIcon = {
                                                Icon(
                                                    Icons.Rounded.SmartDisplay,
                                                    contentDescription = null,
                                                    modifier = Modifier.size(16.dp)
                                                )
                                            },
                                            label = { Text(ch.channelName) }
                                        )
                                    }
                                }
                            } else {
                                Text(
                                    text = "Connect a YouTube channel in Settings -> YouTube before pushing.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = StudioAmber
                                )
                            }

                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                FilterChip(
                                    selected = !schedulePublishLater,
                                    onClick = { schedulePublishLater = false },
                                    label = { Text("Publish Now") }
                                )
                                FilterChip(
                                    selected = schedulePublishLater,
                                    onClick = { schedulePublishLater = true },
                                    label = { Text("Schedule Date & Time") }
                                )
                            }

                            if (schedulePublishLater) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    OutlinedButton(
                                        onClick = { showDatePicker = true },
                                        modifier = Modifier.weight(1f).height(48.dp)
                                    ) {
                                        Icon(Icons.Rounded.CalendarMonth, contentDescription = null, modifier = Modifier.size(18.dp))
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Text(formatLocalDateSummary(scheduledDateMillis), maxLines = 1)
                                    }
                                    OutlinedButton(
                                        onClick = { showTimePicker = true },
                                        modifier = Modifier.weight(0.85f).height(48.dp)
                                    ) {
                                        Icon(Icons.Rounded.Schedule, contentDescription = null, modifier = Modifier.size(18.dp))
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Text(format24hTo12hDisplay(formatHourMinute24(scheduledHour, scheduledMinute)))
                                    }
                                }
                                formatIsoToLocalDisplay(computedPublishAtIso)?.let { label ->
                                    Text(
                                        text = "Scheduled publish time: $label",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = PipelineCyan
                                    )
                                }
                            } else {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    listOf("private" to "Private", "unlisted" to "Unlisted", "public" to "Public").forEach { (p, label) ->
                                        FilterChip(
                                            selected = publishPrivacy == p,
                                            onClick = { publishPrivacy = p },
                                            label = { Text(label) }
                                        )
                                    }
                                }
                            }

                            Button(
                                onClick = {
                                    onPublishProject(
                                        projectId,
                                        PublishProjectRequest(
                                            title = publishTitle.trim().takeIf { it.isNotBlank() },
                                            description = publishDescription.trim(),
                                            tags = publishTagsCsv.split(",").map { it.trim() }.filter { it.isNotBlank() }.take(25),
                                            privacyStatus = if (schedulePublishLater) "private" else publishPrivacy,
                                            scheduledPublishTime = computedPublishAtIso,
                                            youtubeAccountId = selectedChannelId
                                        )
                                    )
                                },
                                enabled = !uiState.isLoading && channels.isNotEmpty(),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(52.dp)
                                    .testTag("approve_push_youtube_button"),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = if (isAwaitingReview) StudioEmerald else SignalCrimson
                                )
                            ) {
                                Icon(Icons.Rounded.CloudUpload, contentDescription = null)
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    text = if (isAwaitingReview)
                                        "Approve & Push to YouTube"
                                    else
                                        "Upload to YouTube Now",
                                    style = MaterialTheme.typography.titleMedium
                                )
                            }
                        }
                    }
                }
            } else if (!project.thumbnailSignedUrl.isNullOrBlank()) {
                item {
                    AsyncImage(
                        model = project.thumbnailSignedUrl,
                        contentDescription = project.title,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .fillMaxWidth()
                            .aspectRatio(16f / 9f)
                            .clip(MaterialTheme.shapes.medium)
                    )
                }
            }

            // 3. Link to Active Pipeline Job Timeline
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
                        Text("Inspect Pipeline Timeline (${latestJob.progress}%)")
                    }
                }
            }

            // 4. Edit Voice, Colorful Subtitles & Open-Source Media Links + Re-Render
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
                                .clickable { expandCreativeStudio = !expandCreativeStudio }
                                .testTag("toggle_creative_studio_button"),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.weight(1f)
                            ) {
                                Icon(Icons.Rounded.Tune, contentDescription = null, tint = PipelineCyan)
                                Spacer(modifier = Modifier.width(8.dp))
                                Column {
                                    Text("Customize Voice, Subtitles & Media Links", style = MaterialTheme.typography.titleMedium)
                                    Text(
                                        text = "Voice: $editVoiceId • Style: ${editSubtitlePreset.uppercase()} • Tap to edit & re-render",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                            Icon(
                                imageVector = if (expandCreativeStudio) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                                contentDescription = "Toggle studio editor"
                            )
                        }

                        if (expandCreativeStudio) {
                            HorizontalDivider()

                            VoiceSelectorSection(
                                selectedProvider = editVoiceProvider,
                                selectedVoiceId = editVoiceId,
                                voiceSpeed = editVoiceSpeed,
                                onProviderChange = {
                                    editVoiceProvider = it
                                    regenerateVoiceOnRerender = true
                                },
                                onVoiceChange = {
                                    editVoiceId = it
                                    regenerateVoiceOnRerender = true
                                },
                                onSpeedChange = {
                                    editVoiceSpeed = it
                                    regenerateVoiceOnRerender = true
                                },
                                voices = voiceState.voices,
                                previewingVoiceId = voiceState.previewingVoiceId,
                                playingVoiceId = voiceState.playingVoiceId,
                                previewError = voiceState.previewError,
                                onPreviewVoice = { vid ->
                                    onPreviewVoice(vid, editVoiceProvider, project.language, editVoiceSpeed)
                                },
                                onStopPreview = onStopVoicePreview,
                                onOpenFullVoiceStudio = onOpenVoiceStudio
                            )

                            HorizontalDivider()

                            SubtitleStyleSelectorSection(
                                enabled = editSubtitlesEnabled,
                                selectedPreset = editSubtitlePreset,
                                selectedPosition = editSubtitlePosition,
                                onEnabledChange = { editSubtitlesEnabled = it },
                                onPresetChange = { editSubtitlePreset = it },
                                onPositionChange = { editSubtitlePosition = it }
                            )

                            HorizontalDivider()

                            MediaSourceAndLinksSection(
                                mediaSourceMode = editMediaSourceMode,
                                customLinksText = editCustomLinksText,
                                onModeChange = {
                                    editMediaSourceMode = it
                                    refetchMediaOnRerender = true
                                },
                                onCustomLinksChange = {
                                    editCustomLinksText = it
                                    if (it.isNotBlank()) refetchMediaOnRerender = true
                                }
                            )

                            HorizontalDivider()

                            ViralProductionControlsSection(
                                editingPace = editEditingPace,
                                bgmMood = editBgmMood,
                                sfxEnabled = editSfxEnabled,
                                colorGrade = editColorGrade,
                                whisperSync = editWhisperSync,
                                hookBannerEnabled = editHookBannerEnabled,
                                onEditingPaceChange = { editEditingPace = it },
                                onBgmMoodChange = { editBgmMood = it },
                                onSfxEnabledChange = { editSfxEnabled = it },
                                onColorGradeChange = { editColorGrade = it },
                                onWhisperSyncChange = { editWhisperSync = it },
                                onHookBannerEnabledChange = { editHookBannerEnabled = it }
                            )

                            HorizontalDivider()

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Checkbox(
                                    checked = regenerateVoiceOnRerender,
                                    onCheckedChange = { regenerateVoiceOnRerender = it }
                                )
                                Text("Regenerate Voiceover", style = MaterialTheme.typography.bodySmall)
                                Spacer(modifier = Modifier.width(12.dp))
                                Checkbox(
                                    checked = refetchMediaOnRerender,
                                    onCheckedChange = { refetchMediaOnRerender = it }
                                )
                                Text("Refetch Visual Media", style = MaterialTheme.typography.bodySmall)
                            }

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                OutlinedButton(
                                    onClick = {
                                        onSaveSettingsAndRerender(projectId, buildSettingsPayload(), null)
                                    },
                                    enabled = !uiState.isLoading,
                                    modifier = Modifier
                                        .weight(0.9f)
                                        .height(48.dp)
                                        .testTag("save_project_settings_button")
                                ) {
                                    Icon(Icons.Rounded.Save, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text("Save Only")
                                }
                                Button(
                                    onClick = {
                                        onSaveSettingsAndRerender(
                                            projectId,
                                            buildSettingsPayload(),
                                            RerenderProjectRequest(
                                                regenerateVoice = regenerateVoiceOnRerender,
                                                refetchMedia = refetchMediaOnRerender,
                                                regenerateScenes = false,
                                                reviewBeforeUpload = true
                                            )
                                        )
                                    },
                                    enabled = !uiState.isLoading,
                                    modifier = Modifier
                                        .weight(1.3f)
                                        .height(48.dp)
                                        .testTag("save_and_rerender_button"),
                                    colors = ButtonDefaults.buttonColors(containerColor = SignalCrimson)
                                ) {
                                    Icon(Icons.Rounded.AutoFixHigh, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text("Save & Re-Render")
                                }
                            }
                        }
                    }
                }
            }

            // 5. Script Editor Card
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
                            minLines = 5,
                            maxLines = 12,
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
                                    onSaveScript(projectId, scriptText, project.title, false)
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
                                    onRegenerateScript(projectId, tone, project.durationSeconds)
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
                                onSaveScript(projectId, scriptText, project.title, true)
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

            // 6. Scene Breakdown & Exact Voiceover-Matched Custom Media Links
            if (detail.scenes.isNotEmpty()) {
                item {
                    StudioSectionHeader(
                        title = "Scenes & Exact Media Links (${detail.scenes.size})",
                        subtitle = "Edit search keywords or paste a direct open-source HTTPS link per scene"
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
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
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
                            OutlinedTextField(
                                value = sceneKeywordsMap[scene.id] ?: scene.primaryKeyword,
                                onValueChange = { sceneKeywordsMap[scene.id] = it },
                                label = { Text("Search Query") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedTextField(
                                value = sceneCustomUrlMap[scene.id].orEmpty(),
                                onValueChange = { sceneCustomUrlMap[scene.id] = it },
                                label = { Text("Custom Open-Source Media URL (HTTPS, optional)") },
                                placeholder = { Text("https://commons.wikimedia.org/wiki/File:...") },
                                leadingIcon = { Icon(Icons.Rounded.Link, contentDescription = null, modifier = Modifier.size(18.dp)) },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                    }
                }

                item {
                    Button(
                        onClick = {
                            onSaveSettingsAndRerender(
                                projectId,
                                buildSettingsPayload(),
                                RerenderProjectRequest(
                                    regenerateVoice = false,
                                    refetchMedia = true,
                                    regenerateScenes = false,
                                    reviewBeforeUpload = true
                                )
                            )
                        },
                        enabled = !uiState.isLoading,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                            .testTag("apply_scene_media_rerender_button"),
                        colors = ButtonDefaults.buttonColors(containerColor = PipelineCyan)
                    ) {
                        Icon(Icons.Rounded.AutoFixHigh, contentDescription = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Apply Scene Media & Re-Render Video")
                    }
                    Spacer(modifier = Modifier.height(16.dp))
                }
            }
        }
    }
}
