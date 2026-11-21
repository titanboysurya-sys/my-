package com.example.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

private val DarkStudioColorScheme = darkColorScheme(
    primary = SignalCrimson,
    onPrimary = OnSignalCrimson,
    primaryContainer = CrimsonContainerDark,
    onPrimaryContainer = CrimsonContainerLight,
    secondary = StudioAmber,
    onSecondary = ObsidianBackground,
    secondaryContainer = AmberContainerDark,
    onSecondaryContainer = AmberContainerLight,
    tertiary = PipelineCyan,
    onTertiary = ObsidianBackground,
    tertiaryContainer = CyanContainerDark,
    onTertiaryContainer = CyanContainerLight,
    background = ObsidianBackground,
    onBackground = ObsidianOnSurface,
    surface = ObsidianSurface,
    onSurface = ObsidianOnSurface,
    surfaceVariant = ObsidianSurfaceVariant,
    onSurfaceVariant = ObsidianOnSurfaceMuted,
    surfaceContainerHigh = ObsidianSurfaceContainerHigh,
    outline = ObsidianOutline,
    error = StudioErrorRed
)

private val LightStudioColorScheme = lightColorScheme(
    primary = SignalCrimsonDark,
    onPrimary = OnSignalCrimson,
    primaryContainer = CrimsonContainerLight,
    onPrimaryContainer = CrimsonContainerDark,
    secondary = StudioAmberDark,
    onSecondary = PaperSurface,
    secondaryContainer = AmberContainerLight,
    onSecondaryContainer = AmberContainerDark,
    tertiary = PipelineCyanDark,
    onTertiary = PaperSurface,
    tertiaryContainer = CyanContainerLight,
    onTertiaryContainer = CyanContainerDark,
    background = PaperBackground,
    onBackground = PaperOnSurface,
    surface = PaperSurface,
    onSurface = PaperOnSurface,
    surfaceVariant = PaperSurfaceVariant,
    onSurfaceVariant = PaperOnSurfaceMuted,
    outline = PaperOutline,
    error = SignalCrimsonDark
)

val StudioShapes = Shapes(
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(22.dp),
    extraLarge = RoundedCornerShape(28.dp)
)

@Composable
fun AutoTubeStudioTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkStudioColorScheme else LightStudioColorScheme

    MaterialTheme(
        colorScheme = colorScheme,
        typography = StudioTypography,
        shapes = StudioShapes,
        content = content
    )
}
