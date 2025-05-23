import { generateObject } from "ai";
import { z } from "zod";
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { retry } from "./retry.js";
import { RateLimiter } from "./rateLimiter.js"; // Updated import path and name
import { CodeFileAnalysisSchema } from "./codeFileAnalysisSchema.js";
const CACHE_DIR = '.analysis_cache';
/**
 * Service responsible for analyzing code files using a Language Model (LLM).
 * It sends the code content to the LLM with specific instructions
 * and expects a structured JSON response conforming to the CodeFileAnalysisSchema.
 */
export class AnalysisService {
    llm;
    rateLimiter; // Updated type
    constructor(llm) {
        this.llm = llm;
        this.rateLimiter = new RateLimiter(); // Initialize renamed rate limiter
    }
    /**
     * Analyzes the content of a code file using the configured LLM.
     * @param content The source code content of the file.
     * @param filePath The relative path of the file being analyzed.
     * @returns A promise that resolves to the analysis results conforming to CodeFileAnalysisSchema,
     *          or an object indicating an analysis error.
     */
    async analyseCode(content, filePath, currentIndex, totalFiles) {
        const progressInfo = currentIndex !== undefined && totalFiles !== undefined ? ` (File ${currentIndex} of ${totalFiles})` : '';
        // --- Caching Logic Start ---
        const currentContentHash = crypto.createHash('sha256').update(content).digest('hex');
        const cacheDir = path.resolve(CACHE_DIR); // Use absolute path relative to project root
        const filePathHash = crypto.createHash('sha256').update(filePath).digest('hex');
        const cacheFilePath = path.join(cacheDir, `${filePathHash}.json`);
        try {
            const cachedContent = await fs.readFile(cacheFilePath, 'utf-8');
            const cachedData = JSON.parse(cachedContent);
            // Validate cache structure and content hash
            if (cachedData && typeof cachedData === 'object' && cachedData.sourceContentHash === currentContentHash && cachedData.analysisResult) {
                console.log(`Cache hit (Content Hash Match) for: ${filePath}${progressInfo}. Reading from cache...`);
                // Re-validate with Zod to ensure schema consistency even with cache
                const validatedCachedResult = CodeFileAnalysisSchema.parse({
                    ...cachedData.analysisResult,
                    source: filePath // Ensure source is correct
                });
                return validatedCachedResult;
            }
            else if (cachedData && cachedData.sourceContentHash !== currentContentHash) {
                console.log(`Cache stale (Content Hash Mismatch) for: ${filePath}${progressInfo}. Re-analyzing...`);
            }
            else {
                console.warn(`Invalid cache data structure for ${filePath}${progressInfo}. Re-analyzing...`);
            }
        }
        catch (cacheError) {
            if (cacheError.code !== 'ENOENT') { // ENOENT = file not found (expected cache miss)
                console.warn(`Cache read error for ${filePath}${progressInfo} (${cacheFilePath}): ${cacheError.message}. Proceeding with LLM analysis.`);
            }
            // If file doesn't exist, hashes mismatch, parse error, or other read error, proceed to LLM analysis
        }
        // --- Caching Logic End ---
        console.log(`Requesting LLM analysis for: ${filePath}${progressInfo}`);
        const fileExtension = filePath.split('.').pop()?.toLowerCase();
        try {
            // Explicitly type the retry call
            const result = await retry(async () => {
                // --- Rate Limiter Check ---
                await this.rateLimiter.waitForPermit();
                // ------------------------
                // Prompt designed to guide the LLM in extracting structured information from code.
                const prompt = `
 Analyse the following source code file.
File Path: ${filePath}

**Instructions:**

1.  **Overall Summary:** Provide a concise summary explaining the file's primary purpose, its main components (classes, functions, etc.), and its role within a larger project if discernible.
2.  **Tags:** Identify relevant keywords, concepts, design patterns, or frameworks used (e.g., 'React Component', 'API Client', 'Data Model', 'Configuration', 'Utility Functions', 'Middleware').
4.  **Structure Extraction:** Extract the following structural elements accurately:
    *   **Imports:** List the names of imported modules, namespaces, or files.
    *   **Exports:** (For JS/TS) List the names of explicitly exported variables, functions, or classes.
    *   **Top-Level Functions/Variables:** List any significant functions or variables defined outside of classes/interfaces. Include their names and optionally signatures/types.
    *   **Classes:** For each class:
        *   Extract its name, signature (declaration line), direct superclass (if any), and implemented interfaces.
        *   Provide a brief summary of the class's purpose.
        *   List its public methods and properties (names and optionally signatures). Note if methods are async or if the class is abstract.
    *   **Interfaces:** (For C#/TS) For each interface:
        *   Extract its name, signature, and any interfaces it extends.
        *   Provide a brief summary of the interface's contract.
        *   List its method and property signatures.
5.  **Focus:** Concentrate on elements defined *within this file*. Do not deeply analyse imported code.
6.  **Output Format:** Respond *only* with a valid JSON object matching the provided schema.

**Source Code:**
\`\`\`${fileExtension}
${content}
\`\`\`
`;
                const { object } = await generateObject({
                    model: this.llm,
                    schema: CodeFileAnalysisSchema, // Use the detailed schema for structured output
                    prompt: prompt,
                    // Optional: Add mode: 'json' if generateObject doesn't default or has issues
                });
                // Validate the LLM output against the schema and ensure the source path is correctly set.
                // The LLM might hallucinate the path, so we overwrite it with the known value.
                const validatedObject = CodeFileAnalysisSchema.parse({
                    ...object,
                    source: filePath, // Ensure filePath is set from our known context
                });
                // --- Cache Write Logic Start ---
                try {
                    await fs.mkdir(cacheDir, { recursive: true }); // Ensure cache directory exists
                    const cacheData = {
                        sourceContentHash: currentContentHash, // Use the hash calculated at the start
                        analysisResult: validatedObject
                    };
                    await fs.writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2));
                    console.log(`Successfully cached analysis for: ${filePath}`);
                }
                catch (writeError) {
                    console.warn(`Cache write error for ${filePath} (${cacheFilePath}): ${writeError.message}`);
                    // Don't fail the overall analysis if caching fails
                }
                // --- Cache Write Logic End ---
                return validatedObject; // Return the Zod-validated object
            }, {
                maxRetries: 5, // Increased retries slightly to accommodate rate limit waits
                initialDelay: 1500,
                onRetry: (error, attempt) => {
                    console.warn(`LLM analysis retry ${attempt} for ${filePath}${progressInfo}: ${error.message}`);
                    // --- Rate Limit Error Handling ---
                    // Attempt to detect rate limits more robustly.
                    // Prioritize structured error info if available (common in HTTP clients).
                    const response = error?.response;
                    const status = response?.status;
                    const headers = response?.headers;
                    const message = error.message || '';
                    let retryAfterSeconds = null;
                    let detectedVia = null; // Track detection method
                    // 1. Check standard HTTP 429 status and Retry-After header
                    if (status === 429) {
                        const retryAfterHeader = headers?.['retry-after'];
                        if (retryAfterHeader && typeof retryAfterHeader === 'string') {
                            const parsedSeconds = parseInt(retryAfterHeader, 10);
                            if (!isNaN(parsedSeconds)) {
                                retryAfterSeconds = parsedSeconds;
                                detectedVia = 'HTTP Header';
                            }
                        }
                        // If status is 429 but header is missing/invalid, we still know it's a rate limit
                        if (!detectedVia) {
                            detectedVia = 'HTTP Status 429';
                        }
                    }
                    // 2. Fallback: Check error message if structured info wasn't conclusive
                    if (!detectedVia && (/rate limit/i.test(message) || /exceeded token rate limit/i.test(message))) {
                        detectedVia = 'Error Message Regex';
                        // Try parsing retry duration from message as a last resort
                        const retryAfterMatch = message.match(/retry after (\d+)/i);
                        if (retryAfterMatch) {
                            const parsedSeconds = parseInt(retryAfterMatch[1], 10);
                            if (!isNaN(parsedSeconds)) {
                                retryAfterSeconds = parsedSeconds;
                                detectedVia = 'Error Message Regex (Parsed Duration)';
                            }
                        }
                    }
                    // 3. If a rate limit was detected (by any means), notify the limiter
                    if (detectedVia) {
                        if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
                            console.log(`Rate limit detected for ${filePath} via ${detectedVia}. Waiting ${retryAfterSeconds} seconds.`);
                            this.rateLimiter.notifyRateLimit(retryAfterSeconds);
                        }
                        else {
                            // Detected rate limit but couldn't get a specific duration
                            const defaultCooldown = 60;
                            console.warn(`Rate limit detected for ${filePath} via ${detectedVia}, but couldn't determine Retry-After duration. Applying default cooldown: ${defaultCooldown} seconds.`);
                            this.rateLimiter.notifyRateLimit(defaultCooldown);
                        }
                    }
                    // --- End Rate Limit Error Handling ---
                }
            });
            console.log(`LLM analysis successful for: ${filePath}${progressInfo}`);
            // Type assertion might be needed if TS still infers unknown, but explicit generic should fix it.
            return result;
        }
        catch (error) {
            // Catch both API/retry errors, Zod validation errors, and potentially cache errors if not caught earlier
            if (error instanceof z.ZodError) {
                console.error(`LLM output validation failed for ${filePath}${progressInfo}:`, error.errors);
            }
            else {
                console.error(`LLM analysis failed for ${filePath}${progressInfo}: ${error}`);
            }
            // Return a specific error object if analysis fails
            return { source: filePath, analysisError: true };
        }
    }
}
