package com.example.ui.screens

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.AudioFile
import androidx.compose.material.icons.rounded.CleaningServices
import androidx.compose.material.icons.rounded.Cloud
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.SmartDisplay
import androidx.compose.material3.Button
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.example.core.datastore.StudioAppSettings
import com.example.core.security.AuthSession
import com.example.ui.components.StudioSectionHeader
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioErrorRed

@Composable
fun SettingsScreen(
    session: AuthSession?,
    settings: StudioAppSettings,
    connectedKeysCount: Int,
    connectedChannelName: String?,
    onOpenApiKeys: () -> Unit,
    onOpenYouTubeSettings: () -> Unit,
    onSaveEndpoints: (backendUrl: String, supabaseUrl: String, anonKey: String) -> Unit,
    onCheckHealth: (String) -> Unit,
    onUpdateTheme: (Boolean) -> Unit,
    onUpdateDefaults: (language: String, format: String, quality: String) -> Unit,
    onToggleNotifications: (Boolean) -> Unit,
    onClearCache: () -> Unit,
    onSignOut: () -> Unit
) {
    var backendUrl by remember(settings.backendApiUrl) { mutableStateOf(settings.backendApiUrl) }
    var supabaseUrl by remember(settings.supabaseUrl) { mutableStateOf(settings.supabaseUrl) }
    var supabaseAnonKey by remember(settings.supabaseAnonKey) { mutableStateOf(settings.supabaseAnonKey) }
    var selectedMusicUri by remember { mutableStateOf<String?>(null) }

    // Zero-permission Storage Access Framework picker for licensed user audio tracks
    val musicPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            selectedMusicUri = uri.lastPathSegment ?: uri.toString()
        }
    }

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        onToggleNotifications(granted)
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("settings_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            StudioSectionHeader(
                title = "Studio Settings",
                subtitle = session?.email ?: "Signed in account"
            )
        }

        // Primary Integration Links (BYOK API Keys & YouTube OAuth)
        item {
            Card(
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
            ) {
                Column {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(onClick = onOpenApiKeys)
                            .padding(16.dp)
                            .testTag("settings_open_api_keys_row"),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.Rounded.Key, contentDescription = null, tint = PipelineCyan)
                        Spacer(modifier = Modifier.width(12.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text("AI Providers & API Keys (BYOK)", style = MaterialTheme.typography.titleMedium)
                            Text(
                                text = "$connectedKeysCount providers connected • Gemini, ElevenLabs, Pexels, Pixabay",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null)
                    }

                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(onClick = onOpenYouTubeSettings)
                            .padding(16.dp)
                            .testTag("settings_open_youtube_row"),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.Rounded.SmartDisplay, contentDescription = null, tint = SignalCrimson)
                        Spacer(modifier = Modifier.width(12.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text("YouTube Account & Channel", style = MaterialTheme.typography.titleMedium)
                            Text(
                                text = connectedChannelName ?: "Not connected • Authorize via Google OAuth 2.0",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null)
                    }
                }
            }
        }

        // Appearance, Video Quality, Default Format & Notifications
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
                    Text("Studio Preferences", style = MaterialTheme.typography.titleMedium)

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text("Obsidian Dark Theme", style = MaterialTheme.typography.titleSmall)
                            Text(
                                text = "Broadcast darkroom mode",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = settings.darkTheme,
                            onCheckedChange = onUpdateTheme,
                            modifier = Modifier.testTag("settings_dark_theme_switch")
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Pipeline & Upload Notifications", style = MaterialTheme.typography.titleSmall)
                            Text(
                                text = "Alert on script ready, render done, upload published, or job failure",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = settings.notificationsEnabled,
                            onCheckedChange = { wantEnabled ->
                                if (wantEnabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                    notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                                } else {
                                    onToggleNotifications(wantEnabled)
                                }
                            },
                            modifier = Modifier.testTag("settings_notifications_switch")
                        )
                    }

                    Text("Default Format", style = MaterialTheme.typography.labelLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("9:16", "16:9", "1:1").forEach { fmt ->
                            FilterChip(
                                selected = settings.defaultFormat == fmt,
                                onClick = { onUpdateDefaults(settings.appLanguage, fmt, settings.defaultQuality) },
                                label = { Text(fmt) }
                            )
                        }
                    }

                    Text("Default Render Quality", style = MaterialTheme.typography.labelLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("720p", "1080p").forEach { q ->
                            FilterChip(
                                selected = settings.defaultQuality == q,
                                onClick = { onUpdateDefaults(settings.appLanguage, settings.defaultFormat, q) },
                                label = { Text(q) }
                            )
                        }
                    }

                    OutlinedButton(
                        onClick = { musicPickerLauncher.launch(arrayOf("audio/*")) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                            .testTag("settings_pick_music_button")
                    ) {
                        Icon(Icons.Rounded.AudioFile, contentDescription = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(selectedMusicUri?.let { "Licensed Track: $it" } ?: "Select Licensed Background Music (SAF)")
                    }
                }
            }
        }

        // Cloud Server Configuration
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
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.Cloud, contentDescription = null, tint = PipelineCyan)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Render Backend & Supabase", style = MaterialTheme.typography.titleMedium)
                    }
                    OutlinedTextField(
                        value = backendUrl,
                        onValueChange = { backendUrl = it },
                        label = { Text("Render Backend API URL") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = supabaseUrl,
                        onValueChange = { supabaseUrl = it },
                        label = { Text("Supabase Project URL") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = supabaseAnonKey,
                        onValueChange = { supabaseAnonKey = it },
                        label = { Text("Supabase Anon Key") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { onSaveEndpoints(backendUrl, supabaseUrl, supabaseAnonKey) },
                            modifier = Modifier
                                .weight(1f)
                                .height(48.dp)
                        ) {
                            Text("Save URLs")
                        }
                        OutlinedButton(
                            onClick = { onCheckHealth(backendUrl) },
                            modifier = Modifier.height(48.dp)
                        ) {
                            Text("Check Health")
                        }
                    }
                }
            }
        }

        // Storage & Sign Out
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                OutlinedButton(
                    onClick = onClearCache,
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp)
                        .testTag("settings_clear_cache_button")
                ) {
                    Icon(Icons.Rounded.CleaningServices, contentDescription = null)
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Clear Cache")
                }
                OutlinedButton(
                    onClick = onSignOut,
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp)
                        .testTag("settings_sign_out_button")
                ) {
                    Icon(Icons.AutoMirrored.Rounded.Logout, contentDescription = null, tint = StudioErrorRed)
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Sign Out", color = StudioErrorRed)
                }
            }
            Spacer(modifier = Modifier.height(20.dp))
        }
    }
}
