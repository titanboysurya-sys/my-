package com.example.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.RocketLaunch
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.SmartDisplay
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.example.core.database.CachedYouTubeChannelEntity
import com.example.core.datastore.StudioAppSettings
import com.example.core.network.CreateProjectRequest
import com.example.core.network.TopicResearchRequest
import com.example.ui.components.MediaSourceAndLinksSection
import com.example.ui.components.StudioSectionHeader
import com.example.ui.components.StudioTimePickerDialog
import com.example.ui.components.SubtitleStyleSelectorSection
import com.example.ui.components.VoiceSelectorSection
import com.example.ui.components.buildUtcIsoFromLocalDateTime
import com.example.ui.components.defaultCountryForLanguage
import com.example.ui.components.format24hTo12hDisplay
import com.example.ui.components.formatHourMinute24
import com.example.ui.components.formatIsoToLocalDisplay
import com.example.ui.components.formatLocalDateSummary
import com.example.ui.components.parseCustomMediaLinks
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioAmber
import com.example.ui.viewmodel.StudioUiState
import com.example.ui.viewmodel.VoiceSettingsUiState
import java.util.Calendar
import java.util.TimeZone

val ALL_STUDIO_NICHES = listOf(
    "Facts", "History", "Technology", "AI News", "Educational", "Comedy",
    "Motivation", "Stories", "Science", "Business", "Finance",
    "Entertainment", "Travel", "Documentary"
)

val STUDIO_LANGUAGES = listOf(
    "en" to "English",
    "hi" to "Hindi (हिंदी)",
    "hinglish" to "Hinglish",
    "es" to "Spanish",
    "fr" to "French",
    "de" to "German",
    "ja" to "Japanese",
    "pt" to "Portuguese"
)

val STUDIO_CONTENT_STYLES = listOf(
    "documentary", "storytelling", "fast_facts", "explainer", "news_brief", "cinematic"
)

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
fun CreateVideoScreen(
    settings: StudioAppSettings,
    uiState: StudioUiState,
    voiceState: VoiceSettingsUiState,
    channels: List<CachedYouTubeChannelEntity> = emptyList(),
    onResearchTopics: (TopicResearchRequest) -> Unit,
    onSelectVoice: (String) -> Unit,
    onSetVoiceProvider: (String) -> Unit,
    onSetVoiceSpeed: (Double) -> Unit,
    onPreviewVoice: (voiceId: String, provider: String, language: String, speed: Double) -> Unit,
    onStopVoicePreview: () -> Unit,
    onOpenVoiceStudio: () -> Unit,
    onGenerateVideo: (CreateProjectRequest) -> Unit
) {
    var topic by rememberSaveable { mutableStateOf("") }
    var selectedNiche by rememberSaveable { mutableStateOf("Facts") }
    var selectedLanguage by rememberSaveable { mutableStateOf(settings.appLanguage) }
    var selectedFormat by rememberSaveable { mutableStateOf(settings.defaultFormat) }
    var selectedDuration by rememberSaveable { mutableIntStateOf(60) }
    var selectedStyle by rememberSaveable { mutableStateOf("documentary") }
    var selectedTopicType by rememberSaveable { mutableStateOf("evergreen") }
    var selectedQuality by rememberSaveable { mutableStateOf(settings.defaultQuality) }
    var subtitlesEnabled by rememberSaveable { mutableStateOf(true) }
    var selectedSubtitlePreset by rememberSaveable { mutableStateOf("mrbeast") }
    var selectedSubtitlePosition by rememberSaveable { mutableStateOf("bottom_safe") }
    var mediaSourceMode by rememberSaveable { mutableStateOf("all") }
    var customMediaLinksText by rememberSaveable { mutableStateOf("") }
    var autoProduce by rememberSaveable { mutableStateOf(true) }
    var autoUpload by rememberSaveable { mutableStateOf(false) }
    var reviewBeforeUpload by rememberSaveable { mutableStateOf(true) }
    var privacyStatus by rememberSaveable { mutableStateOf("private") }

    // Target YouTube channel selector (prevents accidental upload to wrong/multiple channels)
    val defaultChannelId = channels.firstOrNull { it.isDefault }?.id ?: channels.firstOrNull()?.id
    var selectedChannelId by rememberSaveable { mutableStateOf(defaultChannelId) }
    LaunchedEffect(channels) {
        if (selectedChannelId == null || channels.none { it.id == selectedChannelId }) {
            selectedChannelId = channels.firstOrNull { it.isDefault }?.id ?: channels.firstOrNull()?.id
        }
    }

    // Optional Scheduled Publish Date & Time (YouTube status.publishAt)
    var schedulePublishLater by rememberSaveable { mutableStateOf(false) }
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
    var scheduledDateMillis by rememberSaveable { mutableLongStateOf(initialUtcDateMillis) }
    var scheduledHour by rememberSaveable { mutableIntStateOf(initialScheduleCal.get(Calendar.HOUR_OF_DAY)) }
    var scheduledMinute by rememberSaveable { mutableIntStateOf(initialScheduleCal.get(Calendar.MINUTE)) }
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }

    val computedPublishAtIso = if (autoUpload && schedulePublishLater) {
        buildUtcIsoFromLocalDateTime(
            dateMillisUtcMidnight = scheduledDateMillis,
            hour24 = scheduledHour,
            minute = scheduledMinute
        )
    } else {
        null
    }

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
            title = "Select Publish Time",
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

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("create_video_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            StudioSectionHeader(
                title = "Create Automated Video",
                subtitle = "Enter a topic manually or research verified trending/news topics via Gemini + RSS"
            )
        }

        // Topic Input + Verified Research
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
                    OutlinedTextField(
                        value = topic,
                        onValueChange = { topic = it },
                        label = { Text("Video Topic (or leave blank to research)") },
                        placeholder = { Text("e.g., How ancient Roman concrete still heals itself") },
                        minLines = 2,
                        maxLines = 4,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("create_topic_input")
                    )

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        listOf("evergreen" to "Evergreen", "trending" to "Trending", "news" to "Verified News").forEach { (id, label) ->
                            FilterChip(
                                selected = selectedTopicType == id,
                                onClick = { selectedTopicType = id },
                                label = { Text(label) }
                            )
                        }
                    }

                    OutlinedButton(
                        onClick = {
                            onResearchTopics(
                                TopicResearchRequest(
                                    niche = selectedNiche,
                                    language = selectedLanguage,
                                    audienceCountry = defaultCountryForLanguage(selectedLanguage),
                                    contentStyle = selectedStyle,
                                    durationSeconds = selectedDuration,
                                    topicType = selectedTopicType,
                                    count = 4
                                )
                            )
                        },
                        enabled = !uiState.isResearchingTopics,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                            .testTag("research_topics_button")
                    ) {
                        if (uiState.isResearchingTopics) {
                            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Researching Verified Topics...")
                        } else {
                            Icon(Icons.Rounded.Explore, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("AI Research Verified Topics")
                        }
                    }

                    if (uiState.topicSuggestions.isNotEmpty()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                text = "Tap a suggestion to select it:",
                                style = MaterialTheme.typography.labelLarge,
                                color = PipelineCyan
                            )
                            uiState.topicSuggestions.forEach { suggestion ->
                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable { topic = suggestion.topic },
                                    colors = CardDefaults.cardColors(
                                        containerColor = MaterialTheme.colorScheme.surfaceVariant
                                    )
                                ) {
                                    Column(modifier = Modifier.padding(12.dp)) {
                                        Text(
                                            text = suggestion.topic,
                                            style = MaterialTheme.typography.titleSmall
                                        )
                                        if (suggestion.angle.isNotBlank()) {
                                            Text(
                                                text = suggestion.angle,
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant
                                            )
                                        }
                                        if (suggestion.references.isNotEmpty()) {
                                            Text(
                                                text = "Sources: ${suggestion.references.joinToString { it.source }}",
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
            }
        }

        // Niche & Language
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
                    Text("Niche", style = MaterialTheme.typography.titleMedium)
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        ALL_STUDIO_NICHES.forEach { niche ->
                            FilterChip(
                                selected = selectedNiche == niche,
                                onClick = { selectedNiche = niche },
                                label = { Text(niche) }
                            )
                        }
                    }

                    Text("Video Script, Voice & Subtitle Language", style = MaterialTheme.typography.titleMedium)
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        STUDIO_LANGUAGES.forEach { (code, label) ->
                            FilterChip(
                                selected = selectedLanguage == code,
                                onClick = { selectedLanguage = code },
                                label = { Text(label) },
                                modifier = Modifier.testTag("create_lang_$code")
                            )
                        }
                    }
                }
            }
        }

        // Video Format, Duration, Style & Voice
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
                    Text("Video Format & Quality", style = MaterialTheme.typography.titleMedium)
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        listOf("9:16" to "9:16 Shorts", "16:9" to "16:9 Wide", "1:1" to "1:1 Square").forEach { (fmt, label) ->
                            FilterChip(
                                selected = selectedFormat == fmt,
                                onClick = { selectedFormat = fmt },
                                label = { Text(label) }
                            )
                        }
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("720p", "1080p").forEach { q ->
                            FilterChip(
                                selected = selectedQuality == q,
                                onClick = { selectedQuality = q },
                                label = { Text("$q H.264") }
                            )
                        }
                    }

                    Text("Target Video Length", style = MaterialTheme.typography.titleMedium)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(30 to "30s", 60 to "60s", 180 to "3m", 300 to "5m", 600 to "10m").forEach { (sec, label) ->
                            FilterChip(
                                selected = selectedDuration == sec,
                                onClick = { selectedDuration = sec },
                                label = { Text(label) }
                            )
                        }
                    }

                    Text("Content Style", style = MaterialTheme.typography.titleMedium)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        STUDIO_CONTENT_STYLES.forEach { style ->
                            FilterChip(
                                selected = selectedStyle == style,
                                onClick = { selectedStyle = style },
                                label = { Text(style.replace('_', ' ').replaceFirstChar { it.uppercase() }) }
                            )
                        }
                    }
                }
            }
        }

        // Voice Artist Selector (All 30 Official Male & Female Voices + Live Audio Preview)
        item {
            Card(
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
            ) {
                VoiceSelectorSection(
                    selectedProvider = voiceState.selectedProvider,
                    selectedVoiceId = voiceState.selectedVoiceId,
                    voiceSpeed = voiceState.voiceSpeed,
                    onProviderChange = onSetVoiceProvider,
                    onVoiceChange = onSelectVoice,
                    onSpeedChange = onSetVoiceSpeed,
                    voices = voiceState.voices,
                    previewingVoiceId = voiceState.previewingVoiceId,
                    playingVoiceId = voiceState.playingVoiceId,
                    previewError = voiceState.previewError,
                    onPreviewVoice = { vid ->
                        onPreviewVoice(vid, voiceState.selectedProvider, selectedLanguage, voiceState.voiceSpeed)
                    },
                    onStopPreview = onStopVoicePreview,
                    onOpenFullVoiceStudio = onOpenVoiceStudio,
                    modifier = Modifier.padding(16.dp)
                )
            }
        }

        // Colorful Viral Subtitle Style Presets (MrBeast, Hormozi, Neon, Gold, Classic)
        item {
            Card(
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
            ) {
                SubtitleStyleSelectorSection(
                    enabled = subtitlesEnabled,
                    selectedPreset = selectedSubtitlePreset,
                    selectedPosition = selectedSubtitlePosition,
                    onEnabledChange = { subtitlesEnabled = it },
                    onPresetChange = { selectedSubtitlePreset = it },
                    onPositionChange = { selectedSubtitlePosition = it },
                    modifier = Modifier.padding(16.dp)
                )
            }
        }

        // Visual Media Sources & Open-Source Links
        item {
            Card(
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
            ) {
                MediaSourceAndLinksSection(
                    mediaSourceMode = mediaSourceMode,
                    customLinksText = customMediaLinksText,
                    onModeChange = { mediaSourceMode = it },
                    onCustomLinksChange = { customMediaLinksText = it },
                    modifier = Modifier.padding(16.dp)
                )
            }
        }

        // Production, Target Channel & Scheduled YouTube Upload Options
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
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Automatic Production", style = MaterialTheme.typography.titleMedium)
                            Text(
                                text = if (autoProduce)
                                    "Runs full cloud pipeline end-to-end without pausing"
                                else
                                    "Pauses after script generation for your manual review & editing",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = autoProduce,
                            onCheckedChange = { autoProduce = it },
                            modifier = Modifier.testTag("create_auto_produce_switch")
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Auto-Upload to YouTube", style = MaterialTheme.typography.titleMedium)
                            Text(
                                text = "Upload directly to the exact channel & publish time you choose below",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = autoUpload,
                            onCheckedChange = { autoUpload = it },
                            modifier = Modifier.testTag("create_auto_upload_switch")
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Review Video Before YouTube Push", style = MaterialTheme.typography.titleMedium)
                            Text(
                                text = if (reviewBeforeUpload)
                                    "Recommended — pauses after render so you can watch, download, edit voice/subtitles/links, then approve upload"
                                else
                                    "Uploads immediately after rendering without waiting for final preview",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = reviewBeforeUpload,
                            onCheckedChange = { reviewBeforeUpload = it },
                            modifier = Modifier.testTag("create_review_before_upload_switch")
                        )
                    }

                    if (autoUpload) {
                        // Target YouTube Channel Selector
                        Text("Target YouTube Channel", style = MaterialTheme.typography.titleSmall)
                        if (channels.isEmpty()) {
                            Text(
                                text = "No YouTube channel connected yet. Connect a channel in Settings -> YouTube first.",
                                style = MaterialTheme.typography.bodySmall,
                                color = StudioAmber
                            )
                        } else {
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
                                                imageVector = Icons.Rounded.SmartDisplay,
                                                contentDescription = null,
                                                modifier = Modifier.size(16.dp)
                                            )
                                        },
                                        label = {
                                            Text(if (ch.isDefault) "${ch.channelName} ★" else ch.channelName)
                                        },
                                        modifier = Modifier.testTag("create_channel_${ch.id}")
                                    )
                                }
                            }
                        }

                        // Publish Timing: Immediate vs Schedule Date & Time
                        Text("Publish Timing", style = MaterialTheme.typography.titleSmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(
                                selected = !schedulePublishLater,
                                onClick = { schedulePublishLater = false },
                                label = { Text("Publish Right Away") },
                                modifier = Modifier.testTag("create_publish_now_chip")
                            )
                            FilterChip(
                                selected = schedulePublishLater,
                                onClick = { schedulePublishLater = true },
                                label = { Text("Schedule Date & Time") },
                                modifier = Modifier.testTag("create_schedule_later_chip")
                            )
                        }

                        if (schedulePublishLater) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                OutlinedButton(
                                    onClick = { showDatePicker = true },
                                    modifier = Modifier
                                        .weight(1f)
                                        .height(48.dp)
                                        .testTag("create_pick_date_button")
                                ) {
                                    Icon(Icons.Rounded.CalendarMonth, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text(formatLocalDateSummary(scheduledDateMillis), maxLines = 1)
                                }
                                OutlinedButton(
                                    onClick = { showTimePicker = true },
                                    modifier = Modifier
                                        .weight(0.85f)
                                        .height(48.dp)
                                        .testTag("create_pick_time_button")
                                ) {
                                    Icon(Icons.Rounded.Schedule, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text(format24hTo12hDisplay(formatHourMinute24(scheduledHour, scheduledMinute)))
                                }
                            }
                            formatIsoToLocalDisplay(computedPublishAtIso)?.let { localLabel ->
                                Text(
                                    text = "YouTube will automatically publish at: $localLabel",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = PipelineCyan
                                )
                            }
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                listOf("private" to "Private", "unlisted" to "Unlisted", "public" to "Public").forEach { (p, label) ->
                                    FilterChip(
                                        selected = privacyStatus == p,
                                        onClick = { privacyStatus = p },
                                        label = { Text(label) }
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        // Generate CTA
        item {
            Button(
                onClick = {
                    val effectiveTopic = topic.trim().ifBlank { "auto" }
                    val customUrls = parseCustomMediaLinks(customMediaLinksText)
                    onGenerateVideo(
                        CreateProjectRequest(
                            title = if (effectiveTopic == "auto") "Auto $selectedNiche Video" else effectiveTopic.take(80),
                            topic = effectiveTopic,
                            niche = selectedNiche,
                            language = selectedLanguage,
                            audienceCountry = defaultCountryForLanguage(selectedLanguage),
                            contentStyle = selectedStyle,
                            topicType = selectedTopicType,
                            format = selectedFormat,
                            durationSeconds = selectedDuration,
                            qualityPreset = selectedQuality,
                            autoProduce = autoProduce,
                            voiceProvider = voiceState.selectedProvider,
                            voiceId = voiceState.selectedVoiceId,
                            voiceSpeed = voiceState.voiceSpeed,
                            subtitlePreset = selectedSubtitlePreset,
                            subtitlePosition = selectedSubtitlePosition,
                            subtitlesEnabled = subtitlesEnabled,
                            autoUpload = autoUpload,
                            reviewBeforeUpload = reviewBeforeUpload,
                            privacyStatus = if (schedulePublishLater) "private" else privacyStatus,
                            scheduledPublishTime = computedPublishAtIso,
                            youtubeAccountId = if (autoUpload) selectedChannelId else null,
                            mediaSourceMode = mediaSourceMode,
                            customMediaUrls = customUrls.takeIf { it.isNotEmpty() },
                            startImmediately = true
                        )
                    )
                },
                enabled = !uiState.isLoading,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .testTag("generate_video_submit_button"),
                colors = ButtonDefaults.buttonColors(containerColor = SignalCrimson)
            ) {
                if (uiState.isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                    Spacer(modifier = Modifier.width(10.dp))
                    Text("Starting Cloud Pipeline...")
                } else {
                    Icon(Icons.Rounded.RocketLaunch, contentDescription = null)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Generate Video", style = MaterialTheme.typography.titleMedium)
                }
            }
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}
