package com.example.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountCircle
import androidx.compose.material.icons.rounded.CloudDone
import androidx.compose.material.icons.rounded.Email
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.PlayCircle
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import com.example.R
import com.example.core.datastore.StudioAppSettings
import com.example.ui.theme.PipelineCyan
import com.example.ui.theme.SignalCrimson
import com.example.ui.theme.StudioEmerald
import com.example.ui.viewmodel.StudioUiState
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch
import java.security.MessageDigest
import java.util.UUID

private fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}

private fun generateGoogleNoncePair(): Pair<String, String> {
    val rawNonce = UUID.randomUUID().toString()
    val digest = MessageDigest.getInstance("SHA-256").digest(rawNonce.toByteArray())
    val hashedNonce = digest.joinToString("") { "%02x".format(it) }
    return rawNonce to hashedNonce
}

@Composable
fun AuthSetupScreen(
    settings: StudioAppSettings,
    uiState: StudioUiState,
    onCheckHealth: (String) -> Unit,
    onSignInWithGoogleIdToken: (
        idToken: String,
        nonce: String?,
        backendUrl: String,
        supabaseUrl: String,
        anonKey: String,
        googleWebClientId: String
    ) -> Unit,
    onLaunchGoogleBrowserSignIn: (
        backendUrl: String,
        supabaseUrl: String,
        anonKey: String,
        googleWebClientId: String
    ) -> Unit,
    onSignIn: (email: String, password: String, backendUrl: String, supabaseUrl: String, anonKey: String) -> Unit,
    onSignUp: (email: String, password: String, backendUrl: String, supabaseUrl: String, anonKey: String) -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var showEmailLogin by rememberSaveable { mutableStateOf(false) }
    var isSignUpMode by rememberSaveable { mutableStateOf(false) }
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var showPassword by rememberSaveable { mutableStateOf(false) }
    var showCloudConfig by rememberSaveable { mutableStateOf(false) }

    var backendUrl by remember(settings.backendApiUrl) { mutableStateOf(settings.backendApiUrl) }
    var supabaseUrl by remember(settings.supabaseUrl) { mutableStateOf(settings.supabaseUrl) }
    var supabaseAnonKey by remember(settings.supabaseAnonKey) { mutableStateOf(settings.supabaseAnonKey) }
    var googleWebClientId by remember(settings.googleWebClientId) { mutableStateOf(settings.googleWebClientId) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .statusBarsPadding(),
        contentAlignment = Alignment.TopCenter
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 560.dp)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Hero Studio Header Card
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(176.dp)
                    .clip(MaterialTheme.shapes.large)
            ) {
                Image(
                    painter = painterResource(id = R.drawable.img_studio_hero_banner),
                    contentDescription = stringResource(R.string.cd_studio_hero),
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize()
                )
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            Brush.verticalGradient(
                                listOf(
                                    Color.Black.copy(alpha = 0.25f),
                                    Color(0xFF0B0D12).copy(alpha = 0.92f)
                                )
                            )
                        )
                )
                Column(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(18.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Rounded.PlayCircle,
                            contentDescription = null,
                            tint = SignalCrimson,
                            modifier = Modifier.size(28.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "AutoTube Studio",
                            style = MaterialTheme.typography.headlineMedium,
                            color = Color.White
                        )
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "24x7 cloud video automation, FFmpeg rendering & YouTube scheduling",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFFCBD5E1)
                    )
                }
            }

            // Primary Google One-Tap Auth Card
            Card(
                shape = MaterialTheme.shapes.large,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
            ) {
                Column(
                    modifier = Modifier.padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    Text(
                        text = "Sign in to your Studio",
                        style = MaterialTheme.typography.titleLarge
                    )
                    Text(
                        text = "Sign in in one tap with your Google account — no password needed.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    Button(
                        onClick = {
                            val trimmedClientId = googleWebClientId.trim()
                            val activity = context.findActivity()
                            if (trimmedClientId.isNotBlank() && activity != null) {
                                scope.launch {
                                    try {
                                        val (rawNonce, hashedNonce) = generateGoogleNoncePair()
                                        val credentialManager = CredentialManager.create(activity)
                                        val result = try {
                                            // 1) Try native Sign in with Google bottom sheet (with SHA-256 nonce)
                                            val signInOption = GetSignInWithGoogleOption.Builder(trimmedClientId)
                                                .setNonce(hashedNonce)
                                                .build()
                                            credentialManager.getCredential(
                                                context = activity,
                                                request = GetCredentialRequest.Builder()
                                                    .addCredentialOption(signInOption)
                                                    .build()
                                            )
                                        } catch (cancel: GetCredentialCancellationException) {
                                            throw cancel
                                        } catch (_: Exception) {
                                            // 2) Try Google One-Tap GetGoogleIdOption fallback
                                            try {
                                                val oneTapOption = GetGoogleIdOption.Builder()
                                                    .setFilterByAuthorizedAccounts(false)
                                                    .setServerClientId(trimmedClientId)
                                                    .setAutoSelectEnabled(false)
                                                    .setNonce(hashedNonce)
                                                    .build()
                                                credentialManager.getCredential(
                                                    context = activity,
                                                    request = GetCredentialRequest.Builder()
                                                        .addCredentialOption(oneTapOption)
                                                        .build()
                                                )
                                            } catch (cancel: GetCredentialCancellationException) {
                                                throw cancel
                                            } catch (_: Exception) {
                                                null
                                            }
                                        }

                                        val credential = result?.credential
                                        if (credential is CustomCredential &&
                                            credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                                        ) {
                                            val googleCred = GoogleIdTokenCredential.createFrom(credential.data)
                                            onSignInWithGoogleIdToken(
                                                googleCred.idToken,
                                                rawNonce,
                                                backendUrl,
                                                supabaseUrl,
                                                supabaseAnonKey,
                                                trimmedClientId
                                            )
                                        } else {
                                            // 3) Seamless Chrome Custom Tabs Google OAuth fallback
                                            onLaunchGoogleBrowserSignIn(
                                                backendUrl,
                                                supabaseUrl,
                                                supabaseAnonKey,
                                                trimmedClientId
                                            )
                                        }
                                    } catch (_: GetCredentialCancellationException) {
                                        // User intentionally dismissed the Google One-Tap sheet
                                    }
                                }
                            } else {
                                onLaunchGoogleBrowserSignIn(
                                    backendUrl,
                                    supabaseUrl,
                                    supabaseAnonKey,
                                    trimmedClientId
                                )
                            }
                        },
                        enabled = !uiState.isLoading,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(54.dp)
                            .testTag("auth_google_one_tap_button"),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color.White,
                            contentColor = Color(0xFF111827)
                        )
                    ) {
                        if (uiState.isLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                                color = Color(0xFF111827)
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                        } else {
                            Icon(
                                imageVector = Icons.Rounded.AccountCircle,
                                contentDescription = null,
                                tint = Color(0xFF4285F4),
                                modifier = Modifier.size(24.dp)
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                        }
                        Text(
                            text = "Continue with Google (One-Tap)",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold
                        )
                    }

                    TextButton(
                        onClick = {
                            onLaunchGoogleBrowserSignIn(
                                backendUrl,
                                supabaseUrl,
                                supabaseAnonKey,
                                googleWebClientId.trim()
                            )
                        },
                        enabled = !uiState.isLoading,
                        modifier = Modifier
                            .align(Alignment.CenterHorizontally)
                            .testTag("auth_google_browser_fallback_button")
                    ) {
                        Text(
                            text = "Having trouble with One-Tap? Sign in via Google Browser",
                            style = MaterialTheme.typography.labelMedium,
                            color = PipelineCyan
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        HorizontalDivider(modifier = Modifier.weight(1f))
                        TextButton(
                            onClick = { showEmailLogin = !showEmailLogin },
                            modifier = Modifier.testTag("auth_toggle_email_button")
                        ) {
                            Text(
                                text = if (showEmailLogin) "Hide Email Login" else "Use Email & Password",
                                style = MaterialTheme.typography.labelMedium
                            )
                        }
                        HorizontalDivider(modifier = Modifier.weight(1f))
                    }

                    if (showEmailLogin) {
                        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                            SegmentedButton(
                                selected = !isSignUpMode,
                                onClick = { isSignUpMode = false },
                                shape = SegmentedButtonDefaults.itemShape(0, 2),
                                modifier = Modifier.testTag("auth_tab_sign_in")
                            ) { Text("Sign In") }
                            SegmentedButton(
                                selected = isSignUpMode,
                                onClick = { isSignUpMode = true },
                                shape = SegmentedButtonDefaults.itemShape(1, 2),
                                modifier = Modifier.testTag("auth_tab_sign_up")
                            ) { Text("Create Account") }
                        }

                        OutlinedTextField(
                            value = email,
                            onValueChange = { email = it },
                            label = { Text("Email address") },
                            leadingIcon = { Icon(Icons.Rounded.Email, contentDescription = null) },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("auth_email_input")
                        )

                        OutlinedTextField(
                            value = password,
                            onValueChange = { password = it },
                            label = { Text("Password") },
                            leadingIcon = { Icon(Icons.Rounded.Lock, contentDescription = null) },
                            trailingIcon = {
                                IconButton(onClick = { showPassword = !showPassword }) {
                                    Icon(
                                        imageVector = if (showPassword) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                                        contentDescription = "Toggle password visibility"
                                    )
                                }
                            },
                            visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("auth_password_input")
                        )

                        Button(
                            onClick = {
                                if (isSignUpMode) {
                                    onSignUp(email, password, backendUrl, supabaseUrl, supabaseAnonKey)
                                } else {
                                    onSignIn(email, password, backendUrl, supabaseUrl, supabaseAnonKey)
                                }
                            },
                            enabled = !uiState.isLoading,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(48.dp)
                                .testTag("auth_submit_button"),
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
                        ) {
                            Text(if (isSignUpMode) "Create Studio Account" else "Sign In with Email")
                        }
                    }
                }
            }

            // Cloud Backend & Supabase Connection Setup
            Card(
                shape = MaterialTheme.shapes.large,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Rounded.CloudDone,
                                contentDescription = null,
                                tint = PipelineCyan,
                                modifier = Modifier.size(20.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Column {
                                Text(
                                    text = "Cloud Backend & Supabase",
                                    style = MaterialTheme.typography.titleMedium
                                )
                                Text(
                                    text = "Render API + Supabase Auth endpoints",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                        IconButton(onClick = { showCloudConfig = !showCloudConfig }) {
                            Icon(
                                imageVector = if (showCloudConfig) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                                contentDescription = "Toggle cloud server settings"
                            )
                        }
                    }

                    if (showCloudConfig) {
                        Spacer(modifier = Modifier.height(12.dp))
                        OutlinedTextField(
                            value = backendUrl,
                            onValueChange = { backendUrl = it },
                            label = { Text("Render Backend API URL") },
                            placeholder = { Text("https://auto-studio-xm5k.onrender.com") },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("backend_url_input")
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        OutlinedTextField(
                            value = supabaseUrl,
                            onValueChange = { supabaseUrl = it },
                            label = { Text("Supabase Project URL") },
                            placeholder = { Text("https://xxxx.supabase.co") },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("supabase_url_input")
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        OutlinedTextField(
                            value = supabaseAnonKey,
                            onValueChange = { supabaseAnonKey = it },
                            label = { Text("Supabase Publishable / Anon Key") },
                            leadingIcon = { Icon(Icons.Rounded.Key, contentDescription = null) },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("supabase_anon_key_input")
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        OutlinedTextField(
                            value = googleWebClientId,
                            onValueChange = { googleWebClientId = it },
                            label = { Text("Google Web Client ID (Optional Native One-Tap)") },
                            placeholder = { Text("xxxx.apps.googleusercontent.com") },
                            leadingIcon = { Icon(Icons.Rounded.VerifiedUser, contentDescription = null) },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("google_client_id_input")
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            OutlinedButton(
                                onClick = { onCheckHealth(backendUrl) },
                                modifier = Modifier.testTag("test_backend_health_button")
                            ) {
                                Text("Test Backend Health")
                            }
                            uiState.healthCheckResult?.let { health ->
                                Text(
                                    text = if (health.status == "ok") "ONLINE" else health.status,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = StudioEmerald
                                )
                            }
                        }
                    }
                }
            }

            TextButton(
                onClick = { showCloudConfig = true },
                modifier = Modifier.align(Alignment.CenterHorizontally)
            ) {
                Text(
                    text = "Multi-user ready • Encrypted BYOK keys stay strictly on your cloud backend",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}
