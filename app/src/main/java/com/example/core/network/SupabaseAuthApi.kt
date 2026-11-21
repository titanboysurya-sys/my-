package com.example.core.network

import retrofit2.http.Body
import retrofit2.http.Header
import retrofit2.http.POST

interface SupabaseAuthApi {
    @POST("auth/v1/token?grant_type=password")
    suspend fun signInWithPassword(
        @Header("apikey") anonKey: String,
        @Body body: SupabaseAuthRequest
    ): SupabaseAuthResponse

    @POST("auth/v1/signup")
    suspend fun signUp(
        @Header("apikey") anonKey: String,
        @Body body: SupabaseAuthRequest
    ): SupabaseAuthResponse

    @POST("auth/v1/token?grant_type=refresh_token")
    suspend fun refreshSession(
        @Header("apikey") anonKey: String,
        @Body body: SupabaseRefreshRequest
    ): SupabaseAuthResponse
}
