package com.example.ui.components

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.RecordVoiceOver
import androidx.compose.material.icons.rounded.Subtitles
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioAmber
import com.example.ui.theme.StudioEmerald

data class StudioVoiceOption(
    val id: String,
    val displayName: String,
    val gender: String, // "male" or "female"
    val tone: String,
    val badge: String
)

val STUDIO_VOICE_OPTIONS = listOf(
    StudioVoiceOption("Charon", "Charon", "male", "Deep Documentary", "Male"),
    StudioVoiceOption("Fenrir", "Fenrir", "male", "Bold & Exciting", "Male"),
    StudioVoiceOption("Puck", "Puck", "male", "Upbeat & Viral", "Male"),
    StudioVoiceOption("Orus", "Orus", "male", "Firm News Anchor", "Male"),
    StudioVoiceOption("Kore", "Kore", "female", "Clear Narrator", "Female"),
    StudioVoiceOption("Aoede", "Aoede", "female", "Warm Storyteller", "Female"),
    StudioVoiceOption("Leda", "Leda", "female", "Youthful Shorts", "Female"),
    StudioVoiceOption("Zephyr", "Zephyr", "female", "Bright & Friendly", "Female")
)

data class SubtitlePresetOption(
    val id: String,
    val name: String,
    val tagline: String,
    val previewPrefix: String,
    val previewHighlight: String,
    val previewSuffix: String,
    val baseColor: Color,
    val highlightColor: Color,
    val backgroundColor: Color
)

val STUDIO_SUBTITLE_PRESETS = listOf(
    SubtitlePresetOption(
        id = "mrbeast",
        name = "MrBeast Pop",
        tagline = "Punchy bold yellow active pop",
        previewPrefix = "THIS ",
        previewHighlight = "CHANGED",
        previewSuffix = " EVERYTHING",
        baseColor = Color(0xFFFFFFFF),
        highlightColor = Color(0xFFFFE600),
        backgroundColor = Color(0xFF1A1A22)
    ),
    SubtitlePresetOption(
        id = "hormozi",
        name = "Hormozi Viral",
        tagline = "Neon green & gold high-retention",
        previewPrefix = "WATCH ",
        previewHighlight = "THIS",
        previewSuffix = " SECRET",
        baseColor = Color(0xFFFFFFFF),
        highlightColor = Color(0xFF22FF66),
        backgroundColor = Color(0xFF121C18)
    ),
    SubtitlePresetOption(
        id = "neon_glow",
        name = "Neon Cyber",
        tagline = "Electric cyan & magenta glow",
        previewPrefix = "FUTURE ",
        previewHighlight = "AI",
        previewSuffix = " TECH",
        baseColor = Color(0xFFE0FBFF),
        highlightColor = Color(0xFFFF33CC),
        backgroundColor = Color(0xFF121426)
    ),
    SubtitlePresetOption(
        id = "cinematic_gold",
        name = "Cinematic Gold",
        tagline = "Luxury documentary gold pill",
        previewPrefix = "The ",
        previewHighlight = "Hidden",
        previewSuffix = " Story",
        baseColor = Color(0xFFF7F7FA),
        highlightColor = Color(0xFFFFD166),
        backgroundColor = Color(0xFF201A12)
    ),
    SubtitlePresetOption(
        id = "classic",
        name = "Classic Clean",
        tagline = "Minimal readable white captions",
        previewPrefix = "Clear ",
        previewHighlight = "Studio",
        previewSuffix = " Captions",
        baseColor = Color(0xFFFFFFFF),
        highlightColor = Color(0xFF38BDF8),
        backgroundColor = Color(0xFF181A1F)
    )
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun VoiceSelectorSection(
    selectedProvider: String,
    selectedVoiceId: String,
    voiceSpeed: Double,
    onProviderChange: (String) -> Unit,
    onVoiceChange: (String) -> Unit,
    onSpeedChange: (Double) -> Unit,
    modifier: Modifier = Modifier
) {
    var genderFilter by remember { mutableStateOf("all") }
    val filteredVoices = remember(genderFilter) {
        when (genderFilter) {
            "male" -> STUDIO_VOICE_OPTIONS.filter { it.gender == "male" }
            "female" -> STUDIO_VOICE_OPTIONS.filter { it.gender == "female" }
            else -> STUDIO_VOICE_OPTIONS
        }
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = Icons.Rounded.RecordVoiceOver,
                contentDescription = null,
                tint = PipelineCyan,
                modifier = Modifier.size(20.dp)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text("Voice Artist & Provider", style = MaterialTheme.typography.titleMedium)
        }

        // Provider Toggle
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = selectedProvider == "gemini_tts",
                onClick = { onProviderChange("gemini_tts") },
                label = { Text("Gemini TTS") },
                modifier = Modifier.testTag("voice_provider_gemini")
            )
            FilterChip(
                selected = selectedProvider == "elevenlabs",
                onClick = { onProviderChange("elevenlabs") },
                label = { Text("ElevenLabs") },
                modifier = Modifier.testTag("voice_provider_elevenlabs")
            )
        }

        // Gender Filter Chips
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("all" to "All Voices", "male" to "Male", "female" to "Female").forEach { (id, label) ->
                FilterChip(
                    selected = genderFilter == id,
                    onClick = { genderFilter = id },
                    label = { Text(label) },
                    modifier = Modifier.testTag("voice_gender_filter_$id")
                )
            }
        }

        // Voice Selection Cards (2-column grid feel via FlowRow)
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            filteredVoices.forEach { voice ->
                val isSelected = selectedVoiceId.equals(voice.id, ignoreCase = true)
                val accent = if (voice.gender == "male") PipelineCyan else StudioAmber
                Surface(
                    modifier = Modifier
                        .clip(MaterialTheme.shapes.small)
                        .clickable { onVoiceChange(voice.id) }
                        .testTag("voice_option_${voice.id.lowercase()}"),
                    shape = MaterialTheme.shapes.small,
                    color = if (isSelected) accent.copy(alpha = 0.16f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
                    border = BorderStroke(
                        width = if (isSelected) 1.5.dp else 1.dp,
                        color = if (isSelected) accent else MaterialTheme.colorScheme.outline.copy(alpha = 0.6f)
                    )
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Text(
                                text = voice.displayName,
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                            Surface(
                                color = accent.copy(alpha = 0.2f),
                                shape = RoundedCornerShape(999.dp)
                            ) {
                                Text(
                                    text = voice.badge,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = accent,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp)
                                )
                            }
                            if (isSelected) {
                                Icon(
                                    imageVector = Icons.Rounded.CheckCircle,
                                    contentDescription = "Selected voice",
                                    tint = accent,
                                    modifier = Modifier.size(16.dp)
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
                    }
                }
            }
        }

        // Narration Pace / Speed
        Text("Voice Speed", style = MaterialTheme.typography.labelLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(0.9 to "0.9x Calm", 1.0 to "1.0x Natural", 1.12 to "1.12x Fast", 1.25 to "1.25x Viral").forEach { (spd, label) ->
                FilterChip(
                    selected = kotlin.math.abs(voiceSpeed - spd) < 0.04,
                    onClick = { onSpeedChange(spd) },
                    label = { Text(label) }
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SubtitleStyleSelectorSection(
    enabled: Boolean,
    selectedPreset: String,
    selectedPosition: String,
    onEnabledChange: (Boolean) -> Unit,
    onPresetChange: (String) -> Unit,
    onPositionChange: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                Icon(
                    imageVector = Icons.Rounded.Subtitles,
                    contentDescription = null,
                    tint = StudioAmber,
                    modifier = Modifier.size(20.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Column {
                    Text("Colorful Viral Subtitles", style = MaterialTheme.typography.titleMedium)
                    Text(
                        text = "Word-by-word active color highlight burned into MP4",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Switch(
                checked = enabled,
                onCheckedChange = onEnabledChange,
                modifier = Modifier.testTag("subtitles_enabled_switch")
            )
        }

        if (enabled) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                STUDIO_SUBTITLE_PRESETS.forEach { preset ->
                    val isSelected = selectedPreset.equals(preset.id, ignoreCase = true)
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPresetChange(preset.id) }
                            .testTag("subtitle_preset_${preset.id}"),
                        shape = MaterialTheme.shapes.small,
                        colors = CardDefaults.cardColors(
                            containerColor = if (isSelected)
                                preset.highlightColor.copy(alpha = 0.12f)
                            else
                                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)
                        ),
                        border = BorderStroke(
                            width = if (isSelected) 1.5.dp else 1.dp,
                            color = if (isSelected) preset.highlightColor else MaterialTheme.colorScheme.outline.copy(alpha = 0.55f)
                        )
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        text = preset.name,
                                        style = MaterialTheme.typography.titleSmall,
                                        fontWeight = FontWeight.Bold
                                    )
                                    if (isSelected) {
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Icon(
                                            imageVector = Icons.Rounded.CheckCircle,
                                            contentDescription = "Selected subtitle preset",
                                            tint = preset.highlightColor,
                                            modifier = Modifier.size(16.dp)
                                        )
                                    }
                                }
                                Text(
                                    text = preset.tagline,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }

                            Spacer(modifier = Modifier.width(8.dp))

                            // Live Styled Mini Caption Preview
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(preset.backgroundColor)
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = buildAnnotatedString {
                                        withStyle(SpanStyle(color = preset.baseColor, fontWeight = FontWeight.ExtraBold)) {
                                            append(preset.previewPrefix)
                                        }
                                        withStyle(SpanStyle(color = preset.highlightColor, fontWeight = FontWeight.Black)) {
                                            append(preset.previewHighlight)
                                        }
                                        withStyle(SpanStyle(color = preset.baseColor, fontWeight = FontWeight.ExtraBold)) {
                                            append(preset.previewSuffix)
                                        }
                                    },
                                    fontSize = 11.sp,
                                    maxLines = 1
                                )
                            }
                        }
                    }
                }
            }

            Text("Caption Position", style = MaterialTheme.typography.labelLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(
                    "bottom_safe" to "Bottom Safe",
                    "center" to "Center Viral",
                    "top_safe" to "Top Safe"
                ).forEach { (pos, label) ->
                    FilterChip(
                        selected = selectedPosition == pos,
                        onClick = { onPositionChange(pos) },
                        label = { Text(label) },
                        modifier = Modifier.testTag("subtitle_pos_$pos")
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MediaSourceAndLinksSection(
    mediaSourceMode: String,
    customLinksText: String,
    onModeChange: (String) -> Unit,
    onCustomLinksChange: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val parsedLinks = remember(customLinksText) { parseCustomMediaLinks(customLinksText) }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = Icons.Rounded.Public,
                contentDescription = null,
                tint = StudioEmerald,
                modifier = Modifier.size(20.dp)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Column {
                Text("Visual Media Sources & Open-Source Links", style = MaterialTheme.typography.titleMedium)
                Text(
                    text = "Matches stock APIs + Wikimedia, Openverse, NASA & Internet Archive to your voiceover",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            listOf(
                "all" to "All (APIs + Open-Source)",
                "open_source_only" to "Open-Source Only (Free)",
                "api_only" to "Stock APIs Only"
            ).forEach { (id, label) ->
                FilterChip(
                    selected = mediaSourceMode == id,
                    onClick = { onModeChange(id) },
                    label = { Text(label) },
                    modifier = Modifier.testTag("media_source_mode_$id")
                )
            }
        }

        OutlinedTextField(
            value = customLinksText,
            onValueChange = onCustomLinksChange,
            label = { Text("Optional Open-Source Media Links (1 HTTPS URL per line)") },
            placeholder = {
                Text("https://commons.wikimedia.org/wiki/File:...\nhttps://archive.org/details/...\nhttps://images.unsplash.com/...")
            },
            leadingIcon = {
                Icon(Icons.Rounded.Link, contentDescription = null)
            },
            minLines = 2,
            maxLines = 5,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("custom_media_links_input")
        )

        Text(
            text = if (parsedLinks.isNotEmpty())
                "${parsedLinks.size} HTTPS media link(s) ready — mapped sequentially to scenes for exact voiceover match"
            else
                "Paste Wikimedia Commons, Internet Archive, NASA, Openverse, or direct HTTPS MP4/JPG/PNG links (optional).",
            style = MaterialTheme.typography.labelSmall,
            color = if (parsedLinks.isNotEmpty()) StudioEmerald else MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

fun parseCustomMediaLinks(raw: String): List<String> =
    raw.lines()
        .map { it.trim() }
        .filter { it.startsWith("https://", ignoreCase = true) }
        .distinct()
        .take(15)

/**
 * Downloads the rendered MP4 video straight into the device's Downloads folder using Android's
 * system DownloadManager (zero storage permissions needed on Android 10+).
 */
fun downloadVideoWithManager(
    context: Context,
    videoUrl: String,
    title: String
): Boolean {
    return runCatching {
        val uri = Uri.parse(videoUrl)
        require(uri.scheme.equals("https", ignoreCase = true)) { "Only HTTPS video URLs can be downloaded." }

        val safeTitle = title
            .replace(Regex("[^a-zA-Z0-9 _-]"), "")
            .trim()
            .replace(Regex("\\s+"), "_")
            .take(48)
            .ifBlank { "AutoTube_Video" }
        val fileName = "${safeTitle}_${System.currentTimeMillis() % 10000}.mp4"

        val request = DownloadManager.Request(uri)
            .setTitle(title.ifBlank { "AutoTube Studio Video" })
            .setDescription("Downloading rendered MP4 to Downloads")
            .setMimeType("video/mp4")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(true)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)

        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        dm.enqueue(request)
        true
    }.getOrDefault(false)
}

fun shareVideoLink(
    context: Context,
    videoUrl: String,
    title: String
): Boolean {
    return runCatching {
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, title)
            putExtra(Intent.EXTRA_TEXT, "$title\n$videoUrl")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(sendIntent, "Share Rendered Video").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
        true
    }.getOrDefault(false)
}
