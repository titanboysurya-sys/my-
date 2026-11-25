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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.RecordVoiceOver
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.ui.components.StudioBannerMessage
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioAmber
import com.example.ui.theme.StudioEmerald
import com.example.ui.viewmodel.VoiceSettingsUiState

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun VoiceSettingsScreen(
    uiState: VoiceSettingsUiState,
    onSelectVoice: (String) -> Unit,
    onSetProvider: (String) -> Unit,
    onSetSpeed: (Double) -> Unit,
    onSetPreviewLanguage: (String) -> Unit,
    onSetSampleText: (String) -> Unit,
    onSetGenderFilter: (String) -> Unit,
    onSetSearchQuery: (String) -> Unit,
    onPreviewVoice: (String) -> Unit,
    onStopPreview: () -> Unit,
    onRefreshVoices: () -> Unit,
    onDismissFeedback: () -> Unit,
    onBack: () -> Unit
) {
    val maleCount = uiState.voices.count { it.gender == "male" }
    val femaleCount = uiState.voices.count { it.gender == "female" }
    val selected = uiState.selectedVoice

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("voice_settings_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        // Header
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = {
                    onStopPreview()
                    onBack()
                }) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = stringResource(R.string.cd_back))
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text("AI Voice Studio (${uiState.voices.size} Voices)", style = MaterialTheme.typography.titleLarge)
                    Text(
                        text = "Listen to live audio previews & pick your default narration voice",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                IconButton(onClick = onRefreshVoices) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "Refresh voice list")
                }
            }
        }

        // Inline error or confirmation banner
        uiState.previewError?.let { err ->
            item {
                StudioBannerMessage(
                    message = err,
                    isError = true,
                    onDismiss = onDismissFeedback
                )
            }
        }
        uiState.statusMessage?.let { msg ->
            item {
                StudioBannerMessage(
                    message = msg,
                    isError = false,
                    onDismiss = onDismissFeedback
                )
            }
        }

        // Active Selected Voice Card with Live Audition CTA
        item {
            val isPlayingSelected = uiState.playingVoiceId.equals(selected.id, ignoreCase = true)
            val isLoadingSelected = uiState.previewingVoiceId.equals(selected.id, ignoreCase = true)
            Card(
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.5.dp, StudioEmerald.copy(alpha = 0.7f))
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
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                            Icon(
                                imageVector = if (isPlayingSelected) Icons.Rounded.GraphicEq else Icons.Rounded.RecordVoiceOver,
                                contentDescription = null,
                                tint = StudioEmerald
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                            Column {
                                Text(
                                    text = "Active Voice: ${selected.displayName} (${selected.badge})",
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold
                                )
                                Text(
                                    text = "${selected.tone} • ${uiState.selectedProvider.uppercase()} • ${uiState.voiceSpeed}x",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }

                        Button(
                            onClick = {
                                if (isPlayingSelected) onStopPreview() else onPreviewVoice(selected.id)
                            },
                            enabled = !isLoadingSelected,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = if (isPlayingSelected) SignalCrimson else PipelineCyan
                            ),
                            modifier = Modifier
                                .height(48.dp)
                                .testTag("preview_active_voice_button")
                        ) {
                            if (isLoadingSelected) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(18.dp),
                                    strokeWidth = 2.dp,
                                    color = MaterialTheme.colorScheme.onPrimary
                                )
                            } else {
                                Icon(
                                    imageVector = if (isPlayingSelected) Icons.Rounded.Stop else Icons.Rounded.PlayArrow,
                                    contentDescription = if (isPlayingSelected) "Stop preview" else "Play preview"
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                Text(if (isPlayingSelected) "Stop" else "Listen")
                            }
                        }
                    }
                }
            }
        }

        // Provider, Speed, Preview Language & Custom Sample Sentence Card
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
                    Text("Voice Engine & Preview Settings", style = MaterialTheme.typography.titleMedium)

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = uiState.selectedProvider == "gemini_tts",
                            onClick = { onSetProvider("gemini_tts") },
                            label = { Text("Gemini TTS (30 Voices)") },
                            modifier = Modifier.testTag("voice_studio_provider_gemini")
                        )
                        FilterChip(
                            selected = uiState.selectedProvider == "elevenlabs",
                            onClick = { onSetProvider("elevenlabs") },
                            label = { Text("ElevenLabs") },
                            modifier = Modifier.testTag("voice_studio_provider_elevenlabs")
                        )
                    }

                    Text("Preview Language", style = MaterialTheme.typography.labelLarge)
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        STUDIO_LANGUAGES.forEach { (code, label) ->
                            FilterChip(
                                selected = uiState.previewLanguage == code,
                                onClick = { onSetPreviewLanguage(code) },
                                label = { Text(label) }
                            )
                        }
                    }

                    Text("Speaking Pace", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(0.9 to "0.9x Calm", 1.0 to "1.0x Natural", 1.12 to "1.12x Fast", 1.25 to "1.25x Viral").forEach { (spd, label) ->
                            FilterChip(
                                selected = kotlin.math.abs(uiState.voiceSpeed - spd) < 0.04,
                                onClick = { onSetSpeed(spd) },
                                label = { Text(label) }
                            )
                        }
                    }

                    OutlinedTextField(
                        value = uiState.customSampleText,
                        onValueChange = onSetSampleText,
                        label = { Text("Custom Preview Sentence (optional)") },
                        placeholder = { Text("Leave empty for automatic Hindi/English sample...") },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("voice_preview_custom_text_input")
                    )
                }
            }
        }

        // Search + Gender Filter Bar
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = uiState.searchQuery,
                    onValueChange = onSetSearchQuery,
                    leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null) },
                    label = { Text("Search ${uiState.voices.size} voices (name or style)") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("voice_search_input")
                )

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = uiState.genderFilter == "all",
                        onClick = { onSetGenderFilter("all") },
                        label = { Text("All (${uiState.voices.size})") },
                        modifier = Modifier.testTag("voice_studio_filter_all")
                    )
                    FilterChip(
                        selected = uiState.genderFilter == "male",
                        onClick = { onSetGenderFilter("male") },
                        label = { Text("Male ($maleCount)") },
                        modifier = Modifier.testTag("voice_studio_filter_male")
                    )
                    FilterChip(
                        selected = uiState.genderFilter == "female",
                        onClick = { onSetGenderFilter("female") },
                        label = { Text("Female ($femaleCount)") },
                        modifier = Modifier.testTag("voice_studio_filter_female")
                    )
                }
            }
        }

        // All 30 Voices List with Play Preview + Select
        items(uiState.filteredVoices, key = { it.id }) { voice ->
            val isSelected = uiState.selectedVoiceId.equals(voice.id, ignoreCase = true)
            val isPreviewing = uiState.previewingVoiceId.equals(voice.id, ignoreCase = true)
            val isPlaying = uiState.playingVoiceId.equals(voice.id, ignoreCase = true)
            val accent = if (voice.gender == "male") PipelineCyan else StudioAmber

            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onSelectVoice(voice.id) }
                    .testTag("voice_studio_card_${voice.id.lowercase()}"),
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(
                    containerColor = if (isSelected) accent.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surface
                ),
                border = BorderStroke(
                    width = if (isSelected || isPlaying) 1.5.dp else 1.dp,
                    color = when {
                        isPlaying -> StudioEmerald
                        isSelected -> accent
                        else -> MaterialTheme.colorScheme.outline.copy(alpha = 0.7f)
                    }
                )
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(3.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(
                                text = voice.displayName,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                            Surface(
                                color = accent.copy(alpha = 0.18f),
                                shape = RoundedCornerShape(999.dp)
                            ) {
                                Text(
                                    text = voice.badge,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = accent,
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                                )
                            }
                            if (isSelected) {
                                Icon(
                                    imageVector = Icons.Rounded.CheckCircle,
                                    contentDescription = "Selected voice",
                                    tint = StudioEmerald,
                                    modifier = Modifier.size(18.dp)
                                )
                            }
                        }
                        Text(
                            text = voice.tone,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        if (isPlaying) {
                            Text(
                                text = "Playing live preview...",
                                style = MaterialTheme.typography.labelSmall,
                                color = StudioEmerald
                            )
                        }
                    }

                    Spacer(modifier = Modifier.width(8.dp))

                    FilledTonalIconButton(
                        onClick = {
                            if (isPlaying) onStopPreview() else onPreviewVoice(voice.id)
                        },
                        enabled = !isPreviewing,
                        colors = IconButtonDefaults.filledTonalIconButtonColors(
                            containerColor = if (isPlaying) SignalCrimson.copy(alpha = 0.2f) else accent.copy(alpha = 0.16f),
                            contentColor = if (isPlaying) SignalCrimson else accent
                        ),
                        modifier = Modifier
                            .size(48.dp)
                            .testTag("voice_preview_play_${voice.id.lowercase()}")
                    ) {
                        if (isPreviewing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                                color = accent
                            )
                        } else {
                            Icon(
                                imageVector = if (isPlaying) Icons.Rounded.Stop else Icons.Rounded.PlayArrow,
                                contentDescription = if (isPlaying) "Stop ${voice.displayName} preview" else "Play ${voice.displayName} preview"
                            )
                        }
                    }
                }
            }
        }

        item {
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}
