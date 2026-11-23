package com.example.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

val COMMON_TIMEZONES: List<Pair<String, String>> = buildList {
    val deviceTz = TimeZone.getDefault().id
    val presets = listOf(
        "Asia/Kolkata" to "India (IST)",
        "Asia/Dubai" to "Dubai (GST)",
        "Europe/London" to "London (UK)",
        "America/New_York" to "US Eastern",
        "America/Los_Angeles" to "US Pacific",
        "UTC" to "UTC"
    )
    if (presets.none { it.first == deviceTz }) {
        add(deviceTz to "Device ($deviceTz)")
    }
    addAll(presets)
}

fun defaultCountryForLanguage(languageCode: String): String = when (languageCode.trim().lowercase()) {
    "hi", "hinglish" -> "IN"
    "es" -> "ES"
    "fr" -> "FR"
    "de" -> "DE"
    "ja" -> "JP"
    "pt" -> "BR"
    else -> "US"
}

/**
 * Formats an ISO-8601 UTC timestamp (e.g. "2026-11-22T12:30:00.000Z") into the user's
 * local or selected timezone (e.g. "Today, 06:00 PM IST" or "Tomorrow, 09:00 AM IST").
 */
fun formatIsoToLocalDisplay(iso: String?, targetTimeZoneId: String? = null): String? {
    if (iso.isNullOrBlank()) return null
    val parsedDate = parseIsoUtc(iso) ?: return iso.take(16).replace('T', ' ')

    val tz = if (!targetTimeZoneId.isNullOrBlank()) {
        TimeZone.getTimeZone(targetTimeZoneId)
    } else {
        TimeZone.getDefault()
    }

    val nowCal = Calendar.getInstance(tz)
    val targetCal = Calendar.getInstance(tz).apply { time = parsedDate }

    val timeFmt = SimpleDateFormat("hh:mm a z", Locale.getDefault()).apply { timeZone = tz }
    val timeStr = timeFmt.format(parsedDate)

    val isToday = nowCal.get(Calendar.YEAR) == targetCal.get(Calendar.YEAR) &&
        nowCal.get(Calendar.DAY_OF_YEAR) == targetCal.get(Calendar.DAY_OF_YEAR)

    val tomorrowCal = (nowCal.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, 1) }
    val isTomorrow = tomorrowCal.get(Calendar.YEAR) == targetCal.get(Calendar.YEAR) &&
        tomorrowCal.get(Calendar.DAY_OF_YEAR) == targetCal.get(Calendar.DAY_OF_YEAR)

    return when {
        isToday -> "Today, $timeStr"
        isTomorrow -> "Tomorrow, $timeStr"
        else -> {
            val dayFmt = SimpleDateFormat("EEE, dd MMM", Locale.getDefault()).apply { timeZone = tz }
            "${dayFmt.format(parsedDate)} • $timeStr"
        }
    }
}

fun parseIsoUtc(iso: String): Date? {
    val clean = iso.trim()
    val patterns = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ssXXX"
    )
    for (pattern in patterns) {
        try {
            val fmt = SimpleDateFormat(pattern, Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }
            val d = fmt.parse(clean)
            if (d != null) return d
        } catch (_: Exception) {
            // Try next format
        }
    }
    return null
}

/**
 * Formats "HH:MM" (24-hour) into human-friendly 12-hour display (e.g. "18:30" -> "06:30 PM").
 */
fun format24hTo12hDisplay(hhmm: String): String {
    val parts = hhmm.trim().split(":")
    val h = parts.getOrNull(0)?.toIntOrNull()?.coerceIn(0, 23) ?: return hhmm
    val m = parts.getOrNull(1)?.toIntOrNull()?.coerceIn(0, 59) ?: return hhmm
    val amPm = if (h < 12) "AM" else "PM"
    val h12 = when {
        h == 0 -> 12
        h > 12 -> h - 12
        else -> h
    }
    return String.format(Locale.US, "%02d:%02d %s", h12, m, amPm)
}

fun formatHourMinute24(hour: Int, minute: Int): String =
    String.format(Locale.US, "%02d:%02d", hour.coerceIn(0, 23), minute.coerceIn(0, 59))

/**
 * Builds an RFC3339 UTC ISO timestamp for YouTube's `status.publishAt` from a local Date + Time.
 */
fun buildUtcIsoFromLocalDateTime(
    dateMillisUtcMidnight: Long,
    hour24: Int,
    minute: Int,
    timeZoneId: String = TimeZone.getDefault().id
): String {
    // Material3 DatePicker returns UTC midnight for the selected calendar date
    val utcCal = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
        timeInMillis = dateMillisUtcMidnight
    }
    val tz = TimeZone.getTimeZone(timeZoneId)
    val localCal = Calendar.getInstance(tz).apply {
        set(Calendar.YEAR, utcCal.get(Calendar.YEAR))
        set(Calendar.MONTH, utcCal.get(Calendar.MONTH))
        set(Calendar.DAY_OF_MONTH, utcCal.get(Calendar.DAY_OF_MONTH))
        set(Calendar.HOUR_OF_DAY, hour24.coerceIn(0, 23))
        set(Calendar.MINUTE, minute.coerceIn(0, 59))
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }
    val outFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
    return outFmt.format(localCal.time)
}

fun formatLocalDateSummary(dateMillisUtcMidnight: Long): String {
    val fmt = SimpleDateFormat("EEE, dd MMM yyyy", Locale.getDefault()).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
    return fmt.format(Date(dateMillisUtcMidnight))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StudioTimePickerDialog(
    title: String = "Select Publish Time",
    initialHour: Int,
    initialMinute: Int,
    onDismiss: () -> Unit,
    onConfirm: (hour: Int, minute: Int) -> Unit
) {
    val state = rememberTimePickerState(
        initialHour = initialHour.coerceIn(0, 23),
        initialMinute = initialMinute.coerceIn(0, 59),
        is24Hour = false
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                TimePicker(state = state)
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(state.hour, state.minute) }) {
                Text("Confirm")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}
