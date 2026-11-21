package com.example.ui.screens

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoMode
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Save
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.example.core.network.CreateProjectRequest
import com.example.core.network.UpdateScheduleRequest
import com.example.ui.components.StatusPill
import com.example.ui.components.StudioSectionHeader
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioEmerald
import com.example.ui.viewmodel.StudioUiState
import java.util.TimeZone

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AutomationScreen(
    uiState: StudioUiState,
    onSaveSchedule: (UpdateScheduleRequest) -> Unit,
    onToggleAutomation: (Boolean) -> Unit,
    onGenerateNow: (CreateProjectRequest) -> Unit
) {
    val existing = uiState.schedule
    val existingPrefs = existing?.preferences ?: emptyMap()

    var enabled by remember(existing) { mutableStateOf(existing?.enabled ?: uiState.automationEnabled) }
    var niche by remember(existing) { mutableStateOf(existing?.niche ?: "Facts") }
    var language by remember(existing) { mutableStateOf(existing?.language ?: "en") }
    var audienceCountry by remember(existing) { mutableStateOf(existing?.audienceCountry ?: "US") }
    var format by remember(existing) { mutableStateOf(existing?.videoFormat ?: "9:16") }
    var durationSeconds by remember(existing) { mutableIntStateOf(existing?.durationSeconds ?: 60) }
    var videosPerDay by remember(existing) { mutableIntStateOf(existing?.videosPerDay ?: 1) }
    var publishingTime by remember(existing) {
        mutableStateOf(existing?.publishingTimes?.firstOrNull() ?: "14:00")
    }
    var selectedDays by remember(existing) {
        mutableStateOf((existing?.daysOfWeek ?: listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")).toSet())
    }
    var timezone by remember(existing) {
        mutableStateOf(existing?.timezone ?: TimeZone.getDefault().id)
    }
    var preferredTopics by remember(existing) {
        mutableStateOf((existingPrefs["topic_preferences"] as? List<*>)?.joinToString(", ") ?: "")
    }
    var avoidedTopics by remember(existing) {
        mutableStateOf((existingPrefs["avoided_topics"] as? List<*>)?.joinToString(", ") ?: "")
    }
    var voiceProvider by remember(existing) {
        mutableStateOf(existingPrefs["voice_provider"]?.toString() ?: "gemini_tts")
    }
    var subtitleStyle by remember(existing) {
        mutableStateOf(existingPrefs["subtitle_style"]?.toString() ?: "bold_shorts")
    }
    var uploadPrivacy by remember(existing) {
        mutableStateOf(existingPrefs["upload_privacy"]?.toString() ?: "private")
    }
    var autoPublish by remember(existing) {
        mutableStateOf(existingPrefs["auto_publish"] as? Boolean ?: false)
    }
    var maxConcurrentJobs by remember(existing) {
        mutableIntStateOf((existingPrefs["max_concurrent_jobs"] as? Number)?.toInt() ?: 1)
    }
    var maxRetries by remember(existing) {
        mutableIntStateOf((existingPrefs["max_retries"] as? Number)?.toInt() ?: 3)
    }

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
                subtitle = "Runs 24/7 on Render Cron + Worker even when your phone is switched off",
                trailing = {
                    StatusPill(status = if (enabled) "ACTIVE" else "PAUSED")
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
                    if (enabled) StudioEmerald.copy(alpha = 0.6f) else MaterialTheme.colorScheme.outline
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
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Rounded.AutoMode,
                                contentDescription = null,
                                tint = if (enabled) StudioEmerald else MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                            Column {
                                Text("Enable Cloud Autopilot", style = MaterialTheme.typography.titleMedium)
                                Text(
                                    text = uiState.nextScheduledRun?.let {
                                        "Next run: ${it.take(16).replace('T', ' ')} UTC"
                                    } ?: "No upcoming scheduled slot",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                        Switch(
                            checked = enabled,
                            onCheckedChange = {
                                enabled = it
                                onToggleAutomation(it)
                            },
                            modifier = Modifier.testTag("automation_master_switch")
                        )
                    }

                    OutlinedButton(
                        onClick = {
                            onGenerateNow(
                                CreateProjectRequest(
                                    title = "Auto $niche Video",
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
                        Text("Generate Now Using Autopilot Profile")
                    }
                }
            }
        }

        // Content Profile
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
                    Text("Content & Audience", style = MaterialTheme.typography.titleMedium)

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

                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedTextField(
                            value = language,
                            onValueChange = { language = it },
                            label = { Text("Language Code") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = audienceCountry,
                            onValueChange = { audienceCountry = it },
                            label = { Text("Country") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("9:16", "16:9", "1:1").forEach { f ->
                            FilterChip(
                                selected = format == f,
                                onClick = { format = f },
                                label = { Text(f) }
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

        // Schedule Cadence
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
                    Text("Publishing Schedule", style = MaterialTheme.typography.titleMedium)

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        OutlinedTextField(
                            value = publishingTime,
                            onValueChange = { publishingTime = it },
                            label = { Text("Publish Time (HH:MM)") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = timezone,
                            onValueChange = { timezone = it },
                            label = { Text("Time Zone") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                    }

                    Text("Videos per Day: $videosPerDay", style = MaterialTheme.typography.titleSmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(1, 2, 3, 4).forEach { count ->
                            FilterChip(
                                selected = videosPerDay == count,
                                onClick = { videosPerDay = count },
                                label = { Text("$count / day") }
                            )
                        }
                    }

                    Text("Active Days", style = MaterialTheme.typography.titleSmall)
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
                                text = "When off, videos are rendered and held in Studio Library for manual review",
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
                    val safeTime = if (Regex("^\\d{2}:\\d{2}$").matches(publishingTime.trim())) {
                        publishingTime.trim()
                    } else {
                        "14:00"
                    }
                    onSaveSchedule(
                        UpdateScheduleRequest(
                            enabled = enabled,
                            niche = niche,
                            language = language.ifBlank { "en" },
                            audienceCountry = audienceCountry.ifBlank { "US" },
                            videoFormat = format,
                            durationSeconds = durationSeconds,
                            videosPerDay = videosPerDay,
                            publishingTimes = listOf(safeTime),
                            daysOfWeek = selectedDays.toList(),
                            timezone = timezone.ifBlank { "UTC" },
                            preferences = mapOf(
                                "topic_preferences" to preferredTopics.split(",").map { it.trim() }.filter { it.isNotBlank() },
                                "avoided_topics" to avoidedTopics.split(",").map { it.trim() }.filter { it.isNotBlank() },
                                "voice_provider" to voiceProvider,
                                "subtitle_style" to subtitleStyle,
                                "upload_privacy" to uploadPrivacy,
                                "auto_publish" to autoPublish,
                                "max_concurrent_jobs" to maxConcurrentJobs,
                                "max_retries" to maxRetries
                            )
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
                Text("Save Autopilot Configuration")
            }
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}
