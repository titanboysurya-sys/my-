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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.LinkOff
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.SmartDisplay
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import coil.compose.AsyncImage
import com.example.R
import com.example.core.database.CachedYouTubeChannelEntity
import com.example.ui.components.StatusPill
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioErrorRed

@Composable
fun YouTubeSettingsScreen(
    channels: List<CachedYouTubeChannelEntity>,
    isLoading: Boolean,
    onRefresh: () -> Unit,
    onManualRefresh: () -> Unit = onRefresh,
    onConnectYouTube: () -> Unit,
    onDisconnectYouTube: (String?) -> Unit,
    onBack: () -> Unit
) {
    LaunchedEffect(Unit) {
        onRefresh()
    }

    // Re-sync connected channels whenever returning from the OAuth browser tab
    LifecycleResumeEffect(Unit) {
        onRefresh()
        onPauseOrDispose {}
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("youtube_settings_screen"),
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
                    Text("YouTube Integration", style = MaterialTheme.typography.titleLarge)
                    Text(
                        text = "Official YouTube Data API v3 & Google OAuth 2.0",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                IconButton(
                    onClick = onManualRefresh,
                    modifier = Modifier.testTag("youtube_refresh_button")
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = stringResource(R.string.cd_refresh))
                }
            }
        }

        // OAuth Security & Scopes Card
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
                        Icon(Icons.Rounded.Security, contentDescription = null, tint = PipelineCyan)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("OAuth 2.0 Least-Privilege Scopes", style = MaterialTheme.typography.titleMedium)
                    }
                    Text(
                        text = "• youtube.upload — Resumable video & thumbnail uploads\n• youtube.readonly — Verify channel name & upload status\n• Refresh tokens are encrypted with AES-256-GCM on your Render backend. Google passwords are never requested or stored.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    Button(
                        onClick = onConnectYouTube,
                        enabled = !isLoading,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(52.dp)
                            .testTag("youtube_connect_button"),
                        colors = ButtonDefaults.buttonColors(containerColor = SignalCrimson)
                    ) {
                        if (isLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                            Text("Opening Google OAuth…")
                        } else {
                            Icon(Icons.Rounded.SmartDisplay, contentDescription = null)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(if (channels.isEmpty()) "Connect YouTube Channel" else "Reconnect / Add Channel")
                        }
                    }
                }
            }
        }

        if (channels.isEmpty()) {
            item {
                Card(
                    shape = MaterialTheme.shapes.medium,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text("No YouTube channel connected", style = MaterialTheme.typography.titleMedium)
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "Tap Connect YouTube Channel above to authorize your Google/Brand channel in a secure browser tab. After approving, tap Return to AutoTube Studio or tap Refresh above.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center
                        )
                    }
                }
            }
        } else {
            items(channels, key = { it.id }) { channel ->
                Card(
                    shape = MaterialTheme.shapes.medium,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (!channel.thumbnailUrl.isNullOrBlank()) {
                                AsyncImage(
                                    model = channel.thumbnailUrl,
                                    contentDescription = channel.channelName,
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier
                                        .size(52.dp)
                                        .clip(CircleShape)
                                )
                            } else {
                                Box(
                                    modifier = Modifier
                                        .size(52.dp)
                                        .clip(CircleShape)
                                        .background(SignalCrimson.copy(alpha = 0.16f)),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Icon(Icons.Rounded.SmartDisplay, contentDescription = null, tint = SignalCrimson)
                                }
                            }
                            Spacer(modifier = Modifier.width(12.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(channel.channelName, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    text = "${channel.channelHandle ?: channel.channelId} • ${channel.subscriberCount} subscribers",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            StatusPill(status = channel.tokenStatus)
                        }

                        OutlinedButton(
                            onClick = { onDisconnectYouTube(channel.id) },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(48.dp)
                                .testTag("youtube_disconnect_button_${channel.id}")
                        ) {
                            Icon(Icons.Rounded.LinkOff, contentDescription = null, tint = StudioErrorRed)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Disconnect Channel", color = StudioErrorRed)
                        }
                    }
                }
            }
        }
    }
}
