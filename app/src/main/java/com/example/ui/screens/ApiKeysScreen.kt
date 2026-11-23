package com.example.ui.screens

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.core.database.CachedCredentialEntity
import com.example.core.datastore.StudioAppSettings
import com.example.ui.components.StatusPill
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioErrorRed
import com.example.ui.viewmodel.StudioUiState

private data class ProviderDisplaySpec(
    val id: String,
    val displayName: String,
    val roleLabel: String,
    val defaultDocsUrl: String,
    val badgeText: String? = null,
    val keyHint: String? = null
)

private val GROQ_MODEL_OPTIONS = listOf(
    "llama-3.3-70b-versatile" to "Llama 3.3 70B (Best Quality)",
    "llama-3.1-8b-instant" to "Llama 3.1 8B (Ultra High Limit)"
)

private val BYOK_PROVIDER_SPECS = listOf(
    ProviderDisplaySpec(
        id = "groq",
        displayName = "Groq AI",
        roleLabel = "Ultra-Fast Script, Research, Scenes & SEO • High Free Limit",
        defaultDocsUrl = "https://console.groq.com/keys",
        badgeText = "Recommended • Avoids 429",
        keyHint = "gsk_..."
    ),
    ProviderDisplaySpec(
        id = "gemini",
        displayName = "Google Gemini",
        roleLabel = "Script, Research, Scene Breakdown & Gemini TTS Voice-Over",
        defaultDocsUrl = "https://aistudio.google.com/apikey"
    ),
    ProviderDisplaySpec(
        id = "elevenlabs",
        displayName = "ElevenLabs",
        roleLabel = "Studio Voice-Over & Multilingual Narration",
        defaultDocsUrl = "https://elevenlabs.io/app/settings/api-keys"
    ),
    ProviderDisplaySpec(
        id = "pexels",
        displayName = "Pexels",
        roleLabel = "HD Stock Video Clips & Portrait Shorts Footage",
        defaultDocsUrl = "https://www.pexels.com/api/"
    ),
    ProviderDisplaySpec(
        id = "pixabay",
        displayName = "Pixabay",
        roleLabel = "Secondary Stock Video & Photography Source",
        defaultDocsUrl = "https://pixabay.com/api/docs/"
    ),
    ProviderDisplaySpec(
        id = "openai_compatible",
        displayName = "OpenAI-Compatible",
        roleLabel = "Optional Alternative LLM Provider",
        defaultDocsUrl = "https://platform.openai.com/api-keys"
    )
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ApiKeysScreen(
    settings: StudioAppSettings,
    credentials: List<CachedCredentialEntity>,
    uiState: StudioUiState,
    onRefresh: () -> Unit,
    onValidateKey: (provider: String, rawKey: String, providerConfig: Map<String, Any>?) -> Unit,
    onSaveKey: (provider: String, rawKey: String, providerConfig: Map<String, Any>?) -> Unit,
    onRemoveKey: (provider: String) -> Unit,
    onUpdateProviderRouting: (script: String, research: String, voice: String, media: String) -> Unit,
    onBack: () -> Unit
) {
    LaunchedEffect(Unit) {
        onRefresh()
    }

    val byProvider = credentials.associateBy { it.provider }
    var scriptProvider by remember(settings.preferredScriptProvider) { mutableStateOf(settings.preferredScriptProvider) }
    var researchProvider by remember(settings.preferredResearchProvider) { mutableStateOf(settings.preferredResearchProvider) }
    var voiceProvider by remember(settings.preferredVoiceProvider) { mutableStateOf(settings.preferredVoiceProvider) }
    var mediaProviders by remember(settings.preferredMediaProviders) { mutableStateOf(settings.preferredMediaProviders) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .testTag("api_keys_screen"),
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
                    Text("AI Providers & API Keys", style = MaterialTheme.typography.titleLarge)
                    Text(
                        text = "BYOK • Keys are encrypted with AES-256-GCM on your cloud backend",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        // Security Guarantee Notice
        item {
            Card(
                shape = MaterialTheme.shapes.small,
                colors = CardDefaults.cardColors(containerColor = PipelineCyan.copy(alpha = 0.12f)),
                border = BorderStroke(1.dp, PipelineCyan.copy(alpha = 0.4f))
            ) {
                Row(
                    modifier = Modifier.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Rounded.Lock, contentDescription = null, tint = PipelineCyan)
                    Spacer(modifier = Modifier.width(10.dp))
                    Text(
                        text = "Full API keys are never stored in this APK or returned in API responses. Only masked keys are displayed after saving.",
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        }

        // Provider Cards
        items(BYOK_PROVIDER_SPECS, key = { it.id }) { spec ->
            ProviderApiKeyCard(
                spec = spec,
                cached = byProvider[spec.id],
                isBusy = uiState.validatingProvider == spec.id,
                onValidate = { key, cfg -> onValidateKey(spec.id, key, cfg) },
                onSave = { key, cfg -> onSaveKey(spec.id, key, cfg) },
                onRemove = { onRemoveKey(spec.id) }
            )
        }

        // Preferred Provider Routing
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
                    Text("Preferred Provider Routing", style = MaterialTheme.typography.titleMedium)
                    Text(
                        text = "Tip: Connect both Groq & Gemini — if one hits a 429 rate limit, the cloud worker automatically fails over to the other.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    Text("Script, Research & Scenes", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = scriptProvider == "groq",
                            onClick = {
                                scriptProvider = "groq"
                                researchProvider = "groq"
                            },
                            label = { Text("Groq (Fast • High Limit)") },
                            modifier = Modifier.testTag("routing_chip_groq")
                        )
                        FilterChip(
                            selected = scriptProvider == "gemini",
                            onClick = {
                                scriptProvider = "gemini"
                                researchProvider = "gemini"
                            },
                            label = { Text("Gemini") },
                            modifier = Modifier.testTag("routing_chip_gemini")
                        )
                        FilterChip(
                            selected = scriptProvider == "openai_compatible",
                            onClick = {
                                scriptProvider = "openai_compatible"
                                researchProvider = "openai_compatible"
                            },
                            label = { Text("OpenAI-Compatible") },
                            modifier = Modifier.testTag("routing_chip_openai_compatible")
                        )
                    }

                    Text("Voice Narration", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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

                    Text("Media Search", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(
                            "pexels,pixabay" to "Pexels + Pixabay",
                            "pexels" to "Pexels Only",
                            "pixabay" to "Pixabay Only"
                        ).forEach { (value, label) ->
                            FilterChip(
                                selected = mediaProviders == value,
                                onClick = { mediaProviders = value },
                                label = { Text(label) }
                            )
                        }
                    }

                    Button(
                        onClick = {
                            onUpdateProviderRouting(
                                scriptProvider,
                                researchProvider,
                                voiceProvider,
                                mediaProviders
                            )
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                            .testTag("save_provider_routing_button"),
                        colors = ButtonDefaults.buttonColors(containerColor = SignalCrimson)
                    ) {
                        Text("Save Provider Routing")
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProviderApiKeyCard(
    spec: ProviderDisplaySpec,
    cached: CachedCredentialEntity?,
    isBusy: Boolean,
    onValidate: (String, Map<String, Any>?) -> Unit,
    onSave: (String, Map<String, Any>?) -> Unit,
    onRemove: () -> Unit
) {
    val context = LocalContext.current
    var keyInput by remember(spec.id) { mutableStateOf("") }
    var selectedGroqModel by remember(spec.id) { mutableStateOf(GROQ_MODEL_OPTIONS.first().first) }
    val status = if (isBusy) "validating" else (cached?.status ?: "not_connected")
    val docsUrl = cached?.docsUrl?.ifBlank { spec.defaultDocsUrl } ?: spec.defaultDocsUrl
    val currentConfig: Map<String, Any>? = if (spec.id == "groq") {
        mapOf("model" to selectedGroqModel)
    } else {
        null
    }

    Card(
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(
            width = 1.dp,
            color = if (spec.id == "groq") PipelineCyan.copy(alpha = 0.55f) else MaterialTheme.colorScheme.outline
        )
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
                Column(modifier = Modifier.weight(1f)) {
                    Text(spec.displayName, style = MaterialTheme.typography.titleMedium)
                    spec.badgeText?.let { badge ->
                        Text(
                            text = badge,
                            style = MaterialTheme.typography.labelSmall,
                            color = PipelineCyan
                        )
                    }
                    Text(
                        text = spec.roleLabel,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                StatusPill(status = status)
            }

            if (!cached?.maskedKey.isNullOrBlank()) {
                Text(
                    text = "Stored Key: ${cached?.maskedKey}",
                    style = MaterialTheme.typography.labelMedium,
                    color = PipelineCyan
                )
            }

            if (!cached?.usageSummary.isNullOrBlank()) {
                Text(
                    text = "Usage: ${cached?.usageSummary}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            if (!cached?.lastError.isNullOrBlank()) {
                Text(
                    text = "Error: ${cached?.lastError}",
                    style = MaterialTheme.typography.bodySmall,
                    color = StudioErrorRed
                )
            }

            if (spec.id == "groq") {
                Text("Groq Model", style = MaterialTheme.typography.labelMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GROQ_MODEL_OPTIONS.forEach { (modelId, label) ->
                        FilterChip(
                            selected = selectedGroqModel == modelId,
                            onClick = { selectedGroqModel = modelId },
                            label = { Text(label) },
                            modifier = Modifier.testTag("groq_model_chip_$modelId")
                        )
                    }
                }
            }

            OutlinedTextField(
                value = keyInput,
                onValueChange = { keyInput = it },
                label = { Text("Enter ${spec.displayName} API Key") },
                placeholder = spec.keyHint?.let { hint -> { Text(hint) } },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("api_key_input_${spec.id}")
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedButton(
                    onClick = { onValidate(keyInput, currentConfig) },
                    enabled = !isBusy && keyInput.isNotBlank(),
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp)
                        .testTag("validate_key_button_${spec.id}")
                ) {
                    if (isBusy) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Rounded.VerifiedUser, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Validate")
                    }
                }

                Button(
                    onClick = {
                        onSave(keyInput, currentConfig)
                        keyInput = ""
                    },
                    enabled = !isBusy && keyInput.isNotBlank(),
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp)
                        .testTag("save_key_button_${spec.id}"),
                    colors = ButtonDefaults.buttonColors(containerColor = SignalCrimson)
                ) {
                    Text("Save Key")
                }

                if (!cached?.maskedKey.isNullOrBlank()) {
                    IconButton(
                        onClick = onRemove,
                        modifier = Modifier.testTag("remove_key_button_${spec.id}")
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.DeleteOutline,
                            contentDescription = "Remove ${spec.displayName} API key",
                            tint = StudioErrorRed
                        )
                    }
                }
            }

            TextButton(
                onClick = {
                    runCatching {
                        CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(docsUrl))
                    }
                }
            ) {
                Icon(Icons.AutoMirrored.Rounded.OpenInNew, contentDescription = null, modifier = Modifier.size(15.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text("Get ${spec.displayName} API Key & Docs")
            }
        }
    }
}
