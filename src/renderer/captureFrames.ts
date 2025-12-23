import puppeteer from 'puppeteer';
import { extractAudio } from './audio';
import { mergeVideo } from './ffmpeg';
import { writeFile, mkdir, open, stat, readFile, unlink, } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

declare global {
    interface Window {
        __SEEK_VIDEO__: (time: number) => Promise<void>;
        loadDesign: (design: any) => void;
        designReady: boolean;
        __KONVA_STAGE__: any;
    }
}


const MAIN_PROJECT_PATH = 'd:/Projects/clients/mosamem/main';

function getLocalPath(url: string): string | null {
    if (!url) return null;

    // Normalize URL
    let relativePath = '';
    if (url.includes('/storage/')) {
        relativePath = url.split('/storage/')[1];
    } else if (url.includes('storage/')) {
        relativePath = url.split('storage/')[1];
    }

    if (relativePath) {
        // Try to find the file in the main project storage
        const candidates = [
            join(MAIN_PROJECT_PATH, 'storage', 'app', 'public', relativePath),
            join(MAIN_PROJECT_PATH, 'public', 'storage', relativePath)
        ];

        for (const p of candidates) {
            // Fix slashes for Windows
            const normalized = p.replace(/\\/g, '/');
            if (existsSync(normalized)) {
                return normalized;
            }
        }
    }
    return null;
}

function getMediaDuration(filePath: string): number {
    try {
        const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
        const output = execSync(cmd).toString().trim();
        return parseFloat(output) || 0;
    } catch (e) {
        console.error('Failed to get duration for:', filePath, e);
        return 0;
    }
}

// Fallback function to extract video frames using FFmpeg
async function extractVideoFramesWithFFmpeg(videoPath: string, outputDir: string, fps: number, duration: number): Promise<boolean> {
    try {
        console.log('🎬 Attempting FFmpeg frame extraction as fallback...');

        if (!existsSync(videoPath)) {
            console.error('❌ Video file not found for FFmpeg extraction:', videoPath);
            return false;
        }

        // Create output directory
        if (!existsSync(outputDir)) {
            await mkdir(outputDir, { recursive: true });
        }

        // Extract frames using FFmpeg
        const cmd = `ffmpeg -i "${videoPath}" -vf fps=${fps} -t ${duration} "${join(outputDir, 'frame_%d.png')}" -y`;
        console.log('🎬 Running FFmpeg command:', cmd);

        execSync(cmd, { stdio: 'inherit' });

        console.log('✅ FFmpeg frame extraction completed');
        return true;

    } catch (error) {
        console.error('❌ FFmpeg frame extraction failed:', error);
        return false;
    }
}

function processDesignPaths(design: any): any {
    const processed = JSON.parse(JSON.stringify(design)); // Deep copy

    // Helper to process a list of objects
    const processObjects = (objects: any[]) => {
        if (!objects) return;
        for (const obj of objects) {
            if (obj.src) {
                const localPath = getLocalPath(obj.src);
                if (localPath) {
                    console.log(`Mapping URL ${obj.src} -> ${localPath}`);
                    obj.src = localPath; // Use absolute path
                    obj.originalSrc = obj.src;
                }
            }
        }
    };

    // Handle Laravel structure
    if (processed.layers) {
        if (typeof processed.layers === 'string') {
            try {
                const layers = JSON.parse(processed.layers);
                if (layers.objects) processObjects(layers.objects);
                processed.layers = JSON.stringify(layers); // Repack
                // Also expose objects at top level for convenience if needed, 
                // but let's stick to the structure.
                // Actually, if we want audio.ts to work easily, we might want to ensure 'objects' is available.
                // But captureFrames passes 'processed' to loadDesign.
            } catch (e) {
                console.error('Errors parsing layers during path processing', e);
            }
        } else {
            if (processed.layers.objects) processObjects(processed.layers.objects);
        }
    }

    if (processed.objects) {
        processObjects(processed.objects);
    }

    return processed;
}

export async function renderVideo(design: any, exportId: string, webhookUrl?: string) {
    const fps = 24; // Reduced from 30 to 24 fps for smoother video decoding
    const framesDir = join(tmpdir(), exportId);

    // Create frames directory if it doesn't exist
    if (!existsSync(framesDir)) {
        await mkdir(framesDir, { recursive: true });
        console.log('Created frames directory:', framesDir);
    }

    // Process design paths for local file access (for audio extraction only)
    console.log('Processing design paths for local access...');
    const localDesign = processDesignPaths(design);

    // For browser, keep original HTTP URLs
    const browserDesign = design; // Use original design with HTTP URLs

    // 1. Extract Audio FIRST to get its duration
    console.log('Extracting audio...');
    const audioPath = await extractAudio(localDesign);
    let audioDuration = 0;
    if (audioPath && existsSync(audioPath)) {
        audioDuration = getMediaDuration(audioPath);
        console.log('Extracted audio duration:', audioDuration);
    }

    // 2. Calculate Video Max Duration from local files
    let maxVideoDuration = 0;
    const checkObjectsDuration = (objects: any[]) => {
        if (!objects) return;
        for (const obj of objects) {
            const type = obj.customType || obj.type;
            if (type === 'video' && obj.src && existsSync(obj.src)) {
                const d = getMediaDuration(obj.src);
                console.log(`Local video duration (${obj.src}): ${d}`);
                if (d > maxVideoDuration) maxVideoDuration = d;
            }
        }
    };

    // Extract objects from localDesign to check durations
    let designObjects = [];
    if (localDesign.layers) {
        let layers = localDesign.layers;
        if (typeof layers === 'string') layers = JSON.parse(layers);
        if (layers.objects) designObjects = layers.objects;
    } else if (localDesign.objects) {
        designObjects = localDesign.objects;
    }
    checkObjectsDuration(designObjects);

    // 3. Determine Final Duration
    // Use the maximum of video or audio duration
    // If audio is present, we usually want the full audio.
    const duration = Math.max(maxVideoDuration, audioDuration, 5); // Minimum 5s
    console.log(`Final Export Duration: ${duration}s (Audio: ${audioDuration}s, Video: ${maxVideoDuration}s)`);


    const browser = await puppeteer.launch({
        headless: true,
        args: ['--disable-web-security']
    });

    const page = await browser.newPage();

    // Enable request interception to serve local videos with Range support
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
        const url = request.url();
        // Only intercept video files from our storage
        if ((url.endsWith('.mp4') || url.endsWith('.webm') || url.endsWith('.mov')) && url.includes('/storage/')) {
            const localPath = getLocalPath(url);
            if (localPath && existsSync(localPath)) {
                try {
                    const fileSize = (await stat(localPath)).size;
                    const range = request.headers().range;

                    if (range) {
                        const parts = range.replace(/bytes=/, "").split("-");
                        const start = parseInt(parts[0], 10);
                        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                        const chunksize = (end - start) + 1;

                        const fileHandle = await open(localPath, 'r');
                        const buffer = Buffer.alloc(chunksize);
                        await fileHandle.read(buffer, 0, chunksize, start);
                        await fileHandle.close();

                        await request.respond({
                            status: 206,
                            contentType: 'video/mp4',
                            headers: {
                                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                                'Accept-Ranges': 'bytes',
                                'Content-Length': chunksize.toString()
                            },
                            body: buffer
                        });
                    } else {
                        const fileHandle = await open(localPath, 'r');
                        const buffer = await fileHandle.readFile();
                        await fileHandle.close();

                        await request.respond({
                            status: 200,
                            contentType: 'video/mp4',
                            headers: {
                                'Accept-Ranges': 'bytes',
                                'Content-Length': fileSize.toString()
                            },
                            body: buffer
                        });
                    }
                    return;
                } catch (e) {
                    console.error('Error serving local file:', localPath, e);
                    request.continue();
                }
            } else {
                request.continue();
            }
        } else {
            request.continue();
        }
    });

    try {
        console.log('Navigating to render page...');

        const response = await page.goto('http://localhost:8000/render', {
            waitUntil: 'networkidle0',
            timeout: 60000 // Increased timeout
        });

        console.log('Page loaded with status:', response?.status());

        // Wait for loadDesign function to be available
        console.log('Waiting for loadDesign function...');
        await page.waitForFunction(() => typeof (window as any).loadDesign === 'function', { timeout: 10000 });
        console.log('loadDesign function found!');

        // Inject robust seeking function
        await page.evaluate(() => {
            window.__SEEK_VIDEO__ = async (time: number) => {
                if (!Number.isFinite(time)) {
                    console.warn('__SEEK_VIDEO__ ignored non-finite time:', time);
                    return;
                }
                const videos = Array.from(document.querySelectorAll('video'));
                if (videos.length === 0) return;

                const seekPromises = videos.map(v => new Promise<void>((resolve) => {
                    // If already close enough, resolve immediately (0.05s tolerance)
                    if (Math.abs(v.currentTime - time) < 0.05) {
                        resolve();
                        return;
                    }

                    const onSeeked = () => {
                        v.removeEventListener('seeked', onSeeked);
                        resolve();
                    };
                    // Timeout fallback
                    setTimeout(() => {
                        v.removeEventListener('seeked', onSeeked);
                        resolve();
                    }, 2000);

                    v.addEventListener('seeked', onSeeked);
                    v.currentTime = time;
                }));

                await Promise.all(seekPromises);

                // Trigger Konva redraw
                if (window.__KONVA_STAGE__) {
                    window.__KONVA_STAGE__.batchDraw();
                }
            };
        });

        // Inject design (use original design with HTTP URLs for browser)
        await page.evaluate((d) => {
            (window as any).loadDesign(d);
        }, browserDesign);

        // Wait for design to be ready (especially for videos to load)
        await page.waitForFunction(() => {
            return (window as any).designReady === true;
        }, { timeout: 60000 }); // Increased timeout for video loading

        // Ensure videos have metadata
        try {
            await page.waitForFunction(() => {
                const videos = Array.from(document.querySelectorAll('video'));
                return videos.every(v => v.readyState >= 1); // HAVE_METADATA
            }, { timeout: 20000 });
        } catch (e) {
            console.warn('Wait for video metadata timed out');
        }

        console.log('Design is ready, getting video duration...');

        // Skip browser duration detection, we calculated it accurately.
        console.log('Using calculated duration:', duration, 'seconds');

        // Test seeking briefly to ensure file access works
        const seekTest = await page.evaluate(async () => {
            const videos = document.querySelectorAll('video');
            console.log('🧪 Seek test - Found videos:', videos.length);

            if (videos.length > 0) {
                const v = videos[0];
                console.log('🧪 Video before seek test:', {
                    src: v.src,
                    duration: v.duration,
                    currentTime: v.currentTime.toFixed(3),
                    readyState: v.readyState,
                    paused: v.paused
                });

                let testTime = 0.5;
                if (Number.isFinite(v.duration) && v.duration > 0.5) {
                    testTime = Math.min(1.0, v.duration - 0.1);
                } else {
                    console.warn('Video duration is non-finite or too short:', v.duration);
                }

                // Try seeking using our __SEEK_VIDEO__ function
                await window.__SEEK_VIDEO__(testTime);

                const finalTime = v.currentTime;
                const timeDiff = Math.abs(finalTime - testTime);
                const success = timeDiff < 0.5; // More lenient threshold

                console.log('🧪 Seek test result:', {
                    testTime: testTime.toFixed(3),
                    finalTime: finalTime.toFixed(3),
                    timeDiff: timeDiff.toFixed(3),
                    success: success ? '✅' : '❌'
                });

                return { success, timeDiff };
            }

            console.log('🧪 No videos found for seek test');
            return { success: true, timeDiff: 0 };
        });

        console.log('Seek test result:', seekTest);

        // Continue even if seeking isn't perfect - we'll try our best
        if (!seekTest.success && seekTest.timeDiff > 1.0) {
            console.warn('⚠️ Video seeking has significant issues, but continuing with export...');
            console.warn('⚠️ The exported video may have repeated frames or timing issues');
        }

        const totalFrames = Math.floor(duration * fps);
        console.log(`Capturing ${totalFrames} frames at ${fps} fps for ${duration}s duration`);

        let successfulSeeks = 0;
        let failedSeeks = 0;

        // Progress reporting helper
        const reportProgress = async (progress: number, status: string = 'processing') => {
            if (webhookUrl) {
                try {
                    await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            export_id: exportId,
                            progress: progress,
                            status: status
                        })
                    });
                } catch (e) {
                    console.error('Failed to report progress:', e);
                }
            }
        };

        for (let i = 0; i < totalFrames; i++) {
            const time = i / fps;

            // Report progress every 5 frames or so to reduce overhead
            if (i % 5 === 0) {
                const progress = Math.round((i / totalFrames) * 100);
                reportProgress(progress, 'rendering_frames');
            }

            // Add extra debugging for first few frames
            if (i < 5) {
                console.log(`\n🎬 === FRAME ${i}/${totalFrames} (${Math.round((i / totalFrames) * 100)}%) - TIME: ${time.toFixed(2)}s ===`);
            }

            // Seek videos to the specific time
            await page.evaluate(async (t) => {
                await window.__SEEK_VIDEO__(t);
            }, time);

            // Wait for video frames to decode and stabilize
            // Reduced timeout because __SEEK_VIDEO__ now waits for 'seeked' event
            await new Promise(resolve => setTimeout(resolve, 50));

            // Check seeking accuracy for first few frames
            if (i < 5) {
                const videoStatus = await page.evaluate((targetTime) => {
                    const videos = document.querySelectorAll('video');
                    return Array.from(videos).map((video, index) => ({
                        index,
                        currentTime: video.currentTime.toFixed(3),
                        targetTime: targetTime.toFixed(3),
                        timeDiff: Math.abs(video.currentTime - targetTime).toFixed(3),
                        seeking: video.seeking,
                        success: Math.abs(video.currentTime - targetTime) < 0.5
                    }));
                }, time);

                console.log(`📹 Frame ${i} video status:`, videoStatus);

                // Track seeking success
                const allSuccessful = videoStatus.every(v => v.success);
                if (allSuccessful) {
                    successfulSeeks++;
                } else {
                    failedSeeks++;
                }
            }

            // Capture the frame with higher quality
            const dataUrl = await page.evaluate(() => {
                // Ensure the stage is fully rendered
                const stage = (window as any).__KONVA_STAGE__;
                stage.batchDraw();

                // Wait a tiny bit for the draw to complete
                return new Promise<string>(resolve => {
                    setTimeout(() => {
                        resolve(stage.toDataURL({
                            pixelRatio: 2, // Higher quality
                            mimeType: 'image/png',
                            quality: 1.0
                        }));
                    }, 20); // Increased wait time
                });
            }) as string;

            if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.includes('data:image')) {
                console.warn(`⚠️ Frame ${i} has invalid dataUrl:`, typeof dataUrl, dataUrl?.toString().substring(0, 50));
                continue;
            }

            const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
            const framePath = join(framesDir, `frame_${i}.png`);
            await writeFile(framePath, buffer);

            if (i % 30 === 0) console.log(`Saved frame ${i}/${totalFrames}`);
        }

        // Report seeking accuracy
        if (successfulSeeks + failedSeeks > 0) {
            const accuracy = (successfulSeeks / (successfulSeeks + failedSeeks)) * 100;
            console.log(`📊 Seeking accuracy: ${accuracy.toFixed(1)}% (${successfulSeeks}/${successfulSeeks + failedSeeks} successful)`);

            if (accuracy < 50) {
                console.warn('⚠️ Low seeking accuracy detected - exported video may have timing issues');

                // Check if we have a single video that we could extract with FFmpeg as fallback
                let videoPath = null;
                if (designObjects.length === 1) {
                    const obj = designObjects[0];
                    if ((obj.customType || obj.type) === 'video' && obj.src && existsSync(obj.src)) {
                        videoPath = obj.src;
                    }
                }

                if (videoPath && accuracy < 20) {
                    console.log('🎬 Attempting FFmpeg fallback for single video design...');
                    const ffmpegSuccess = await extractVideoFramesWithFFmpeg(videoPath, framesDir, fps, duration);

                    if (ffmpegSuccess) {
                        console.log('✅ FFmpeg fallback successful - using extracted frames');
                        // Continue with merging - frames are already extracted
                        await mergeVideo(framesDir, audioPath, exportId);
                        return;
                    } else {
                        console.warn('❌ FFmpeg fallback also failed - continuing with browser frames');
                    }
                }
            }
        }

        // Merge using the already extracted audio path
        await reportProgress(90, 'merging_video');
        await mergeVideo(framesDir, audioPath, exportId);

        // Upload to Laravel
        await reportProgress(95, 'uploading');
        const videoPath = join(framesDir, '..', `${exportId}.mp4`);

        if (existsSync(videoPath)) {
            try {
                const formData = new FormData();
                const videoBuffer = await readFile(videoPath);
                const blob = new Blob([videoBuffer], { type: 'video/mp4' });

                formData.append('export_id', exportId);
                formData.append('video', blob, `${exportId}.mp4`);

                const laravelUrl = process.env.LARAVEL_APP_URL || 'http://localhost:8000';
                console.log(`Uploading video to ${laravelUrl}/export/webhook/store`);

                const uploadRes = await fetch(`${laravelUrl}/export/webhook/store`, {
                    method: 'POST',
                    body: formData as any
                });

                if (!uploadRes.ok) {
                    const errorText = await uploadRes.text();
                    console.error(`Upload failed response: ${errorText}`);
                    throw new Error(`Upload failed with status: ${uploadRes.status} - ${errorText}`);
                }
                console.log('Video uploaded successfully');

                await reportProgress(100, 'completed');
            } catch (error) {
                console.error('Upload failed:', error);
                await reportProgress(100, 'failed'); // Indicate failure or keep it stuck? Let's say failed but maybe we should handle retry.
                // Actually, if upload fails, key functionality fails.
                throw error;
            }

            // Cleanup
            try {
                await unlink(videoPath);
                // Clean frames dir as well - assuming it's done or we can do it here. 
                // framesDir is usually inside a temp folder for the ID.
                // We should remove the whole exportId temp folder.
                // For now, let's minimally clean up the video.
                // Ideally, a proper cleanup routine should exist.
            } catch (e) {
                console.error('Cleanup failed:', e);
            }
        } else {
            console.error('Video file not found after merge:', videoPath);
            await reportProgress(100, 'failed');
        }

    } catch (error) {
        console.error('Error in renderVideo:', error);
        throw error;
    } finally {
        await browser.close();
    }
}

