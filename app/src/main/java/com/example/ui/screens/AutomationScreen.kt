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
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AutoMode
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.Save
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.SmartDisplay
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.example.core.database.CachedYouTubeChannelEntity
import com.example.core.network.CreateProjectRequest
import com.example.core.network.UpdateScheduleRequest
import com.example.ui.components.COMMON_TIMEZONES
import com.example.ui.components.StatusPill
import com.example.ui.components.StudioSectionHeader
import com.example.ui.components.StudioTimePickerDialog
import com.example.ui.components.defaultCountryForLanguage
import com.example.ui.components.format24hTo12hDisplay
import com.example.ui.components.formatHourMinute24
import com.example.ui.components.formatIsoToLocalDisplay
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioEmerald
import com.example.ui.viewmodel.StudioUiState
import java.util.TimeZone

private data class ChannelAutopilotProfile(
    val channelId: String,
    val channelName: String,
    val enabled: Boolean,
    val niche: String,
    val language: String,
    val audienceCountry: String,
    val videoFormat: String,
    val durationSeconds: Int,
    val videosPerDay: Int,
    val publishingTimes: List<String>,
    val daysOfWeek: Set<String>,
    val timezone: String,
    val voiceProvider: String,
    val autoPublish: Boolean,
    val uploadPrivacy: String,
    val preferredTopics: String,
    val avoidedTopics: String,
    val nextRunAt: String? = null
)

private fun parseChannelSchedules(
    existingPrefs: Map<String, Any?>
): Map<String, ChannelAutopilotProfile> {
    val rawList = existingPrefs["channel_schedules"] as? List<*> ?: return emptyMap()
    val result = mutableMapOf<String, ChannelAutopilotProfile>()
    for (item in rawList) {
        val m = item as? Map<*, *> ?: continue
        val cid = m["channelId"]?.toString()?.takeIf { it.isNotBlank() } ?: continue
        val pubTimes = (m["publishingTimes"] as? List<*>)
            ?.mapNotNull { it?.toString()?.takeIf { s -> Regex("^\\d{2}:\\d{2}$").matches(s) } }
            ?.takeIf { it.isNotEmpty() }
            ?: listOf("18:00")
        val days = (m["daysOfWeek"] as? List<*>)
            ?.mapNotNull { it?.toString()?.lowercase() }
            ?.toSet()
            ?.takeIf { it.isNotEmpty() }
            ?: setOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")
        val lang = m["language"]?.toString()?.ifBlank { "en" } ?: "en"
        result[cid] = ChannelAutopilotProfile(
            channelId = cid,
            channelName = m["channelName"]?.toString() ?: "YouTube Channel",
            enabled = m["enabled"] as? Boolean ?: false,
            niche = m["niche"]?.toString() ?: "Facts",
            language = lang,
            audienceCountry = m["audienceCountry"]?.toString() ?: defaultCountryForLanguage(lang),
            videoFormat = m["videoFormat"]?.toString() ?: "9:16",
            durationSeconds = (m["durationSeconds"] as? Number)?.toInt() ?: 60,
            videosPerDay = (m["videosPerDay"] as? Number)?.toInt() ?: pubTimes.size.coerceAtLeast(1),
            publishingTimes = pubTimes,
            daysOfWeek = days,
            timezone = m["timezone"]?.toString()?.ifBlank { TimeZone.getDefault().id } ?: TimeZone.getDefault().id,
            voiceProvider = m["voiceProvider"]?.toString() ?: "gemini_tts",
            autoPublish = m["autoPublish"] as? Boolean ?: true,
            uploadPrivacy = m["uploadPrivacy"]?.toString() ?: "private",
            preferredTopics = (m["preferredTopics"] as? List<*>)?.joinToString(", ") ?: "",
            avoidedTopics = (m["avoidedTopics"] as? List<*>)?.joinToString(", ") ?: "",
            nextRunAt = m["nextRunAt"]?.toString()
        )
    }
    return result
}

private fun ChannelAutopilotProfile.toWireMap(): Map<String, Any> = mapOf(
    "channelId" to channelId,
    "channelName" to channelName,
    "enabled" to enabled,
    "niche" to niche,
    "language" to language,
    "audienceCountry" to audienceCountry,
    "videoFormat" to videoFormat,
    "durationSeconds" to durationSeconds,
    "videosPerDay" to publishingTimes.size.coerceAtLeast(1),
    "publishingTimes" to publishingTimes,
    "daysOfWeek" to daysOfWeek.toList(),
    "timezone" to timezone,
    "voiceProvider" to voiceProvider,
    "autoPublish" to autoPublish,
    "uploadPrivacy" to uploadPrivacy,
    "preferredTopics" to preferredTopics.split(",").map { it.trim() }.filter { it.isNotBlank() },
    "avoidedTopics" to avoidedTopics.split(",").map { it.trim() }.filter { it.isNotBlank() }
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AutomationScreen(
    uiState: StudioUiState,
    channels: List<CachedYouTubeChannelEntity> = emptyList(),
    onSaveSchedule: (UpdateScheduleRequest) -> Unit,
    onToggleAutomation: (Boolean) -> Unit,
    onGenerateNow: (CreateProjectRequest) -> Unit
) {
    val existing = uiState.schedule
    val existingPrefs = existing?.preferences ?: emptyMap()
    val savedChannelMap = remember(existing) { parseChannelSchedules(existingPrefs) }

    var masterEnabled by remember(existing) { mutableStateOf(existing?.enabled ?: uiState.automationEnabled) }
    var selectedChannelId by remember(channels) {
        mutableStateOf(channels.firstOrNull { it.isDefault }?.id ?: channels.firstOrNull()?.id)
    }

    // Active form state (bound to selected channel when channels exist, or master schedule otherwise)
    val selectedChannel = channels.firstOrNull { it.id == selectedChannelId }
    val activeSavedChannel = selectedChannelId?.let { savedChannelMap[it] }

    var channelEnabled by remember(existing, selectedChannelId) {
        mutableStateOf(activeSavedChannel?.enabled ?: true)
    }
    var niche by remember(existing, selectedChannelId) {
        mutableStateOf(activeSavedChannel?.niche ?: existing?.niche ?: "Facts")
    }
    var language by remember(existing, selectedChannelId) {
        mutableStateOf(activeSavedChannel?.language ?: existing?.language ?: "hi")
    }
    var audienceCountry by remember(existing, selectedChannelId) {
        mutableStateOf(
            activeSavedChannel?.audienceCountry
                ?: existing?.audienceCountry
                ?: defaultCountryForLanguage(language)
        )
    }
    var format by remember(existing, selectedChannelId) {
        mutableStateOf(activeSavedChannel?.videoFormat ?: existing?.videoFormat ?: "9:16")
    }
    var durationSeconds by remember(existing, selectedChannelId) {
        mutableIntStateOf(activeSavedChannel?.durationSeconds ?: existing?.durationSeconds ?: 60)
    }
    var publishingTimes by remember(existing, selectedChannelId) {
        val raw = activeSavedChannel?.publishingTimes
            ?: existing?.publishingTimes?.takeIf { it.isNotEmpty() }
            ?: listOf("18:00")
        mutableStateOf(raw)
    }
    var selectedDays by remember(existing, selectedChannelId) {
        mutableStateOf(
            activeSavedChannel?.daysOfWeek
                ?: (existing?.daysOfWeek ?: listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")).toSet()
        )
    }
    var timezone by remember(existing, selectedChannelId) {
        val defaultTz = TimeZone.getDefault().id
        val loadedTz = activeSavedChannel?.timezone ?: existing?.timezone
        mutableStateOf(
            if (loadedTz.isNullOrBlank() || loadedTz == "UTC") defaultTz else loadedTz
        )
    }
    var preferredTopics by remember(existing, selectedChannelId) {
        mutableStateOf(
            activeSavedChannel?.preferredTopics
                ?: (existingPrefs["topic_preferences"] as? List<*>)?.joinToString(", ")
                ?: ""
        )
    }
    var avoidedTopics by remember(existing, selectedChannelId) {
        mutableStateOf(
            activeSavedChannel?.avoidedTopics
                ?: (existingPrefs["avoided_topics"] as? List<*>)?.joinToString(", ")
                ?: ""
        )
    }
    var voiceProvider by remember(existing, selectedChannelId) {
        mutableStateOf(
            activeSavedChannel?.voiceProvider
                ?: existingPrefs["voice_provider"]?.toString()
                ?: "gemini_tts"
        )
    }
    var subtitleStyle by remember(existing) {
        mutableStateOf(existingPrefs["subtitle_style"]?.toString() ?: "bold_shorts")
    }
    var uploadPrivacy by remember(existing, selectedChannelId) {
        mutableStateOf(
            activeSavedChannel?.uploadPrivacy
                ?: existingPrefs["upload_privacy"]?.toString()
                ?: "private"
        )
    }
    var autoPublish by remember(existing, selectedChannelId) {
        mutableStateOf(
            activeSavedChannel?.autoPublish
                ?: (existingPrefs["auto_publish"] as? Boolean ?: true)
        )
    }
    var maxConcurrentJobs by remember(existing) {
        mutableIntStateOf((existingPrefs["max_concurrent_jobs"] as? Number)?.toInt() ?: 1)
    }
    var maxRetries by remember(existing) {
        mutableIntStateOf((existingPrefs["max_retries"] as? Number)?.toInt() ?: 3)
    }

    LaunchedEffect(channels) {
        if (selectedChannelId == null || channels.none { it.id == selectedChannelId }) {
            selectedChannelId = channels.firstOrNull { it.isDefault }?.id ?: channels.firstOrNull()?.id
        }
    }

    // Time picker state: editingIndex == -1 means adding a new daily slot; >= 0 replaces that slot
    var timePickerEditIndex by remember { mutableStateOf<Int?>(null) }

    timePickerEditIndex?.let { editIdx ->
        val existingSlot = if (editIdx in publishingTimes.indices) publishingTimes[editIdx] else "18:00"
        val parts = existingSlot.split(":")
        val initH = parts.getOrNull(0)?.toIntOrNull() ?: 18
        val initM = parts.getOrNull(1)?.toIntOrNull() ?: 0

        StudioTimePickerDialog(
            title = if (editIdx >= 0) "Change Publish Time" else "Add Daily Publish Time",
            initialHour = initH,
            initialMinute = initM,
            onDismiss = { timePickerEditIndex = null },
            onConfirm = { h, m ->
                val formatted = formatHourMinute24(h, m)
                publishingTimes = if (editIdx in publishingTimes.indices) {
                    publishingTimes.toMutableList().apply { this[editIdx] = formatted }.distinct().sorted()
                } else {
                    (publishingTimes + formatted).distinct().sorted().take(4)
                }
                timePickerEditIndex = null
            }
        )
    }

    val nextRunDisplay = formatIsoToLocalDisplay(
        iso = activeSavedChannel?.nextRunAt ?: uiState.nextScheduledRun,
        targetTimeZoneId = timezone
    )

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("automation_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            StudioSectionHeader(
                title = "Cloud Autopilot",
                subtitle = "Runs 24/7 in the cloud on your exact local schedule with separate channel profiles",
                trailing = {
                    StatusPill(status = if (masterEnabled) "ACTIVE" else "PAUSED")
                }
            )
        }

        // Master Autopilot Card
        item {
            Card(
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(
                    1.dp,
                    if (masterEnabled) StudioEmerald.copy(alpha = 0.6f) else MaterialTheme.colorScheme.outline
                )
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
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.AutoMode,
                                contentDescription = null,
                                tint = if (masterEnabled) StudioEmerald else MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                            Column {
                                Text("Enable Cloud Autopilot", style = MaterialTheme.typography.titleMedium)
                                Text(
                                    text = nextRunDisplay?.let { "Next run: $it" }
                                        ?: "Save schedule below to activate your next slot",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (nextRunDisplay != null) PipelineCyan else MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                        Switch(
                            checked = masterEnabled,
                            onCheckedChange = {
                                masterEnabled = it
                                onToggleAutomation(it)
                            },
                            modifier = Modifier.testTag("automation_master_switch")
                        )
                    }

                    OutlinedButton(
                        onClick = {
                            onGenerateNow(
                                CreateProjectRequest(
                                    title = selectedChannel?.let { "Auto $niche (${it.channelName})" }
                                        ?: "Auto $niche Video",
                                    topic = "auto",
                                    niche = niche,
                                    language = language,
                                    audienceCountry = audienceCountry,
                                    format = format,
                                    durationSeconds = durationSeconds,
                                    autoProduce = true,
                                    voiceProvider = voiceProvider,
                                    autoUpload = autoPublish,
                                    privacyStatus = uploadPrivacy,
                                    youtubeAccountId = if (autoPublish) selectedChannelId else null,
                                    startImmediately = true
                                )
                            )
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                            .testTag("automation_generate_now_button")
                    ) {
                        Icon(Icons.Rounded.Bolt, contentDescription = null)
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            selectedChannel?.let { "Generate Now for ${it.channelName}" }
                                ?: "Generate Now Using Autopilot Profile"
                        )
                    }
                }
            }
        }

        // Independent Multi-Channel Autopilot Selector
        if (channels.isNotEmpty()) {
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
                        Text("Channel Autopilot Profile", style = MaterialTheme.typography.titleMedium)
                        Text(
                            text = "Each connected channel gets its own independent niche, language, and upload schedule — videos never duplicate across channels.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )

                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            channels.forEach { ch ->
                                val saved = savedChannelMap[ch.id]
                                val isActiveForChannel = saved?.enabled ?: false
                                FilterChip(
                                    selected = selectedChannelId == ch.id,
                                    onClick = { selectedChannelId = ch.id },
                                    leadingIcon = {
                                        Icon(
                                            imageVector = Icons.Rounded.SmartDisplay,
                                            contentDescription = null,
                                            modifier = Modifier.size(16.dp),
                                            tint = if (isActiveForChannel) StudioEmerald else MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    },
                                    label = {
                                        Text(
                                            if (isActiveForChannel) "${ch.channelName} • ON" else ch.channelName
                                        )
                                    },
                                    modifier = Modifier.testTag("automation_channel_${ch.id}")
                                )
                            }
                        }

                        selectedChannel?.let { ch ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = "Run Autopilot for ${ch.channelName}",
                                        style = MaterialTheme.typography.titleSmall
                                    )
                                    Text(
                                        text = if (channelEnabled)
                                            "Active — generates unique videos exclusively for ${ch.channelName}"
                                        else
                                            "Paused for this channel",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                Switch(
                                    checked = channelEnabled,
                                    onCheckedChange = { channelEnabled = it },
                                    modifier = Modifier.testTag("automation_channel_enabled_switch")
                                )
                            }
                        }
                    }
                }
            }
        }

        // Content Profile (Niche, Language Chips, Format, Duration)
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
                    Text(
                        text = selectedChannel?.let { "Content & Language (${it.channelName})" }
                            ?: "Content & Language",
                        style = MaterialTheme.typography.titleMedium
                    )

                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        ALL_STUDIO_NICHES.forEach { n ->
                            FilterChip(
                                selected = niche == n,
                                onClick = { niche = n },
                                label = { Text(n) }
                            )
                        }
                    }

                    Text("Video Language (Script, Voice & Subtitles)", style = MaterialTheme.typography.titleSmall)
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        STUDIO_LANGUAGES.forEach { (code, label) ->
                            FilterChip(
                                selected = language == code,
                                onClick = {
                                    language = code
                                    audienceCountry = defaultCountryForLanguage(code)
                                },
                                label = { Text(label) },
                                modifier = Modifier.testTag("automation_lang_$code")
                            )
                        }
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("9:16" to "9:16 Shorts", "16:9" to "16:9 Wide", "1:1" to "1:1 Square").forEach { (f, label) ->
                            FilterChip(
                                selected = format == f,
                                onClick = { format = f },
                                label = { Text(label) }
                            )
                        }
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(30 to "30s", 60 to "60s", 180 to "3m", 300 to "5m").forEach { (sec, label) ->
                            FilterChip(
                                selected = durationSeconds == sec,
                                onClick = { durationSeconds = sec },
                                label = { Text(label) }
                            )
                        }
                    }
                }
            }
        }

        // Schedule Cadence with Material 3 Time Picker & Local Timezone Selector
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
                    Text("Daily Publishing Time & Timezone", style = MaterialTheme.typography.titleMedium)

                    Text(
                        text = "Tap a time to change it, or add up to 4 daily publishing slots (${publishingTimes.size}/day):",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        publishingTimes.forEachIndexed { idx, hhmm ->
                            InputChip(
                                selected = true,
                                onClick = { timePickerEditIndex = idx },
                                leadingIcon = {
                                    Icon(
                                        imageVector = Icons.Rounded.Schedule,
                                        contentDescription = null,
                                        modifier = Modifier.size(16.dp)
                                    )
                                },
                                trailingIcon = if (publishingTimes.size > 1) {
                                    {
                                        Icon(
                                            imageVector = Icons.Rounded.Close,
                                            contentDescription = "Remove time slot",
                                            modifier = Modifier
                                                .size(18.dp)
                                                .clickable {
                                                    publishingTimes = publishingTimes.filterIndexed { i, _ -> i != idx }
                                                }
                                        )
                                    }
                                } else null,
                                label = { Text(format24hTo12hDisplay(hhmm)) },
                                modifier = Modifier.testTag("automation_time_slot_$idx")
                            )
                        }

                        if (publishingTimes.size < 4) {
                            OutlinedButton(
                                onClick = { timePickerEditIndex = -1 },
                                modifier = Modifier
                                    .height(40.dp)
                                    .testTag("automation_add_time_button"),
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)
                            ) {
                                Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(modifier = Modifier.width(4.dp))
                                Text("Add Time")
                            }
                        }
                    }

                    if (publishingTimes.size > 1) {
                        Text(
                            text = "Tip: Tap a chip to edit its clock time; tap Reset to 1 slot if you want only 1 video/day.",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        OutlinedButton(
                            onClick = { publishingTimes = listOf(publishingTimes.first()) },
                            modifier = Modifier.height(36.dp),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 2.dp)
                        ) {
                            Text("Keep Only 1 Slot (${format24hTo12hDisplay(publishingTimes.first())})")
                        }
                    }

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Rounded.Public,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = PipelineCyan
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Timezone: $timezone", style = MaterialTheme.typography.titleSmall)
                    }
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        COMMON_TIMEZONES.forEach { (tzId, label) ->
                            FilterChip(
                                selected = timezone == tzId,
                                onClick = { timezone = tzId },
                                label = { Text(label) }
                            )
                        }
                    }

                    Text("Active Days of Week", style = MaterialTheme.typography.titleSmall)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun").forEach { day ->
                            val isSelected = selectedDays.contains(day)
                            FilterChip(
                                selected = isSelected,
                                onClick = {
                                    selectedDays = if (isSelected && selectedDays.size > 1) {
                                        selectedDays - day
                                    } else {
                                        selectedDays + day
                                    }
                                },
                                label = { Text(day.uppercase()) }
                            )
                        }
                    }

                    OutlinedTextField(
                        value = preferredTopics,
                        onValueChange = { preferredTopics = it },
                        label = { Text("Preferred Topics (comma-separated)") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = avoidedTopics,
                        onValueChange = { avoidedTopics = it },
                        label = { Text("Avoided Topics (comma-separated)") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }

        // Publishing, Concurrency & Retries
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
                    Text("Voice, Subtitles & YouTube Policy", style = MaterialTheme.typography.titleMedium)

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = voiceProvider == "gemini_tts",
                            onClick = { voiceProvider = "gemini_tts" },
                            label = { Text("Gemini TTS") }
                        )
                        FilterChip(
                            selected = voiceProvider == "elevenlabs",
                            onClick = { voiceProvider = "elevenlabs" },
                            label = { Text("ElevenLabs") }
                        )
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("bold_shorts" to "Bold Shorts", "classic_clean" to "Classic Clean", "minimal" to "Minimal").forEach { (id, label) ->
                            FilterChip(
                                selected = subtitleStyle == id,
                                onClick = { subtitleStyle = id },
                                label = { Text(label) }
                            )
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Authorize Automatic Publishing", style = MaterialTheme.typography.titleSmall)
                            Text(
                                text = "When on, uploads automatically at your scheduled time to the selected channel",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(checked = autoPublish, onCheckedChange = { autoPublish = it })
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("private", "unlisted", "public").forEach { priv ->
                            FilterChip(
                                selected = uploadPrivacy == priv,
                                onClick = { uploadPrivacy = priv },
                                label = { Text(priv.replaceFirstChar { it.uppercase() }) }
                            )
                        }
                    }

                    Text(
                        text = "Max Concurrent Jobs: $maxConcurrentJobs • Max Retries: $maxRetries",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(1, 2, 3).forEach { c ->
                            FilterChip(
                                selected = maxConcurrentJobs == c,
                                onClick = { maxConcurrentJobs = c },
                                label = { Text("$c Concurrent") }
                            )
                        }
                        listOf(2, 3, 5).forEach { r ->
                            FilterChip(
                                selected = maxRetries == r,
                                onClick = { maxRetries = r },
                                label = { Text("$r Retries") }
                            )
                        }
                    }
                }
            }
        }

        // Save Schedule Button
        item {
            Button(
                onClick = {
                    val safeTimes = publishingTimes
                        .filter { Regex("^\\d{2}:\\d{2}$").matches(it) }
                        .ifEmpty { listOf("18:00") }
                    val safeTz = timezone.ifBlank { TimeZone.getDefault().id }

                    // Merge current channel profile into preferences.channel_schedules without losing other channels
                    val mergedChannelSchedules = savedChannelMap.toMutableMap()
                    if (selectedChannel != null) {
                        mergedChannelSchedules[selectedChannel.id] = ChannelAutopilotProfile(
                            channelId = selectedChannel.id,
                            channelName = selectedChannel.channelName,
                            enabled = channelEnabled,
                            niche = niche,
                            language = language,
                            audienceCountry = audienceCountry,
                            videoFormat = format,
                            durationSeconds = durationSeconds,
                            videosPerDay = safeTimes.size,
                            publishingTimes = safeTimes,
                            daysOfWeek = selectedDays,
                            timezone = safeTz,
                            voiceProvider = voiceProvider,
                            autoPublish = autoPublish,
                            uploadPrivacy = uploadPrivacy,
                            preferredTopics = preferredTopics,
                            avoidedTopics = avoidedTopics
                        )
                    }

                    val prefsPayload = mutableMapOf<String, Any>(
                        "topic_preferences" to preferredTopics.split(",").map { it.trim() }.filter { it.isNotBlank() },
                        "avoided_topics" to avoidedTopics.split(",").map { it.trim() }.filter { it.isNotBlank() },
                        "voice_provider" to voiceProvider,
                        "subtitle_style" to subtitleStyle,
                        "upload_privacy" to uploadPrivacy,
                        "auto_publish" to autoPublish,
                        "max_concurrent_jobs" to maxConcurrentJobs,
                        "max_retries" to maxRetries
                    )
                    if (mergedChannelSchedules.isNotEmpty()) {
                        prefsPayload["channel_schedules"] = mergedChannelSchedules.values.map { it.toWireMap() }
                    }
                    if (selectedChannel != null) {
                        prefsPayload["youtube_account_id"] = selectedChannel.id
                    }

                    onSaveSchedule(
                        UpdateScheduleRequest(
                            enabled = masterEnabled,
                            niche = niche,
                            language = language.ifBlank { "en" },
                            audienceCountry = audienceCountry.ifBlank { defaultCountryForLanguage(language) },
                            videoFormat = format,
                            durationSeconds = durationSeconds,
                            videosPerDay = safeTimes.size,
                            publishingTimes = safeTimes,
                            daysOfWeek = selectedDays.toList(),
                            timezone = safeTz,
                            preferences = prefsPayload
                        )
                    )
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .testTag("save_automation_settings_button"),
                colors = ButtonDefaults.buttonColors(containerColor = SignalCrimson)
            ) {
                Icon(Icons.Rounded.Save, contentDescription = null)
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    selectedChannel?.let { "Save Schedule for ${it.channelName}" }
                        ?: "Save Autopilot Configuration"
                )
            }
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}
