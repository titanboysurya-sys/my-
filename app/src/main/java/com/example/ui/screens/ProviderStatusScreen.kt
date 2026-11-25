package com.example.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.example.core.database.CachedCredentialEntity
import com.example.core.datastore.StudioAppSettings
import com.example.ui.components.StatusPill
import com.example.ui.components.StudioSectionHeader
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioErrorRed
import com.example.ui.viewmodel.StudioUiState

private data class ProviderStatusInfo(
    val providerId: String,
    val displayName: String,
    val role: String,
    val defaultDocsUrl: String
)

private val MONITORED_PROVIDERS = listOf(
    ProviderStatusInfo("groq", "Groq AI (Llama 3.3)", "High-throughput LLM for script, research, scenes & SEO", "https://console.groq.com/keys"),
    ProviderStatusInfo("gemini", "Google Gemini", "Core LLM & Gemini TTS voice-over generation", "https://aistudio.google.com/apikey"),
    ProviderStatusInfo("elevenlabs", "ElevenLabs", "Studio voice-over & multilingual narration", "https://elevenlabs.io/app/settings/api-keys"),
    ProviderStatusInfo("pexels", "Pexels Stock Media", "HD stock video clips & portrait shorts footage", "https://www.pexels.com/api/"),
    ProviderStatusInfo("pixabay", "Pixabay Stock Media", "Secondary stock video & photography source", "https://pixabay.com/api/docs/")
)

@Composable
fun ProviderStatusScreen(
    credentials: List<CachedCredentialEntity>,
    uiState: StudioUiState,
    onRefresh: () -> Unit,
    onOpenApiKeys: () -> Unit,
    onBack: () -> Unit
) {
    LaunchedEffect(Unit) {
        onRefresh()
    }

    val byProvider = credentials.associateBy { it.provider }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("provider_status_screen"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(
                    onClick = onBack,
                    modifier = Modifier.testTag("provider_status_back_button")
                ) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
                }
                Spacer(modifier = Modifier.width(8.dp))
                Column(modifier = Modifier.weight(1f)) {
                    StudioSectionHeader(
                        title = "AI Provider Status",
                        subtitle = "Real-time health telemetry from cloud & Supabase"
                    )
                }
                IconButton(
                    onClick = onRefresh,
                    modifier = Modifier.testTag("provider_status_refresh_button")
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "Refresh Status")
                }
            }
        }

        // Overall System Telemetry Summary
        item {
            Card(
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text("Backend & Telemetry Health", style = MaterialTheme.typography.titleMedium)
                    val health = uiState.healthCheckResult
                    val isBackendOk = health != null
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Cloud API Endpoint", style = MaterialTheme.typography.bodyMedium)
                        StatusPill(status = if (isBackendOk) "connected" else "not_connected")
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Supabase Cloud Sync", style = MaterialTheme.typography.bodyMedium)
                        StatusPill(status = if (health?.supabaseConfigured == true) "connected" else "not_connected")
                    }
                }
            }
        }

        // List each provider status
        items(MONITORED_PROVIDERS) { spec ->
            val cred = byProvider[spec.providerId]
            val isConnected = cred?.status == "connected"
            val containerColor = if (isConnected) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.2f)
            val badgeColor = if (isConnected) PipelineCyan else StudioErrorRed

            Card(
                shape = MaterialTheme.shapes.medium,
                colors = CardDefaults.cardColors(containerColor = containerColor),
                border = BorderStroke(1.dp, if (isConnected) MaterialTheme.colorScheme.outline else StudioErrorRed.copy(alpha = 0.5f)),
                modifier = Modifier.testTag("provider_status_card_${spec.providerId}")
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                            Icon(
                                imageVector = if (isConnected) Icons.Rounded.CheckCircle else Icons.Rounded.WarningAmber,
                                contentDescription = null,
                                tint = badgeColor,
                                modifier = Modifier.size(24.dp)
                            )
                            Spacer(modifier = Modifier.width(12.dp))
                            Column {
                                Text(spec.displayName, style = MaterialTheme.typography.titleMedium)
                                Text(spec.role, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        StatusPill(status = cred?.status ?: "not_connected")
                    }

                    if (cred?.maskedKey != null) {
                        Text(
                            text = "Key: ${cred.maskedKey}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    if (!cred?.lastValidatedAt.isNullOrBlank()) {
                        Text(
                            text = "Last Validated: ${cred.lastValidatedAt}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    if (!cred?.lastError.isNullOrBlank()) {
                        Text(
                            text = "Error: ${cred.lastError}",
                            style = MaterialTheme.typography.bodySmall,
                            color = StudioErrorRed
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End
                    ) {
                        OutlinedButton(
                            onClick = onOpenApiKeys,
                            modifier = Modifier.testTag("configure_${spec.providerId}_button")
                        ) {
                            Text("Configure Key")
                        }
                    }
                }
            }
        }
    }
}
