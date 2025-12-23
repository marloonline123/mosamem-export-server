import puppeteer from 'puppeteer';
import { extractAudio } from './audio';
import { mergeVideo } from './ffmpeg';
import { writeFile, mkdir, open, stat, readFile, unlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, extname } from 'path';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

declare global {
    interface Window {
        __SEEK_VIDEO__: (time: number) => Promise<void>;
        loadDesign: (design: any) => void;
        designReady: boolean;
        __KONVA_STAGE__: any;
    }
}

// Helper to clean up the entire export directory
async function cleanupExport(exportId: string) {
    const exportDir = join(tmpdir(), exportId);
    if (existsSync(exportDir)) {
        try {
            console.log(`🧹 Cleaning up export directory: ${exportDir}`);
            await rm(exportDir, { recursive: true, force: true });
            console.log('✨ Cleanup successful');
        } catch (e) {
            console.error(`❌ Failed to cleanup directory ${exportDir}:`, e);
        }
    }
}

async function downloadAsset(url: string, assetsDir: string): Promise<string> {
    if (!url || !url.startsWith('http')) return url;

    try {
        // Create a safe filename from URL using hash to avoid weird characters
        const urlHash = createHash('md5').update(url).digest('hex');
        // Try to keep extension or default to .bin
        let ext = extname(url).split('?')[0];
        if (!ext || ext.length > 5) ext = '.bin';

        const localPath = join(assetsDir, `${urlHash}${ext}`);

        // If file already exists in this export's temp dir, return it
        if (existsSync(localPath)) {
            return localPath;
        }

        console.log(`⬇️ Downloading remote asset: ${url}`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);

        const arrayBuffer = await response.arrayBuffer();
        await writeFile(localPath, Buffer.from(arrayBuffer));

        console.log(`✅ Asset downloaded to: ${localPath}`);
        return localPath;

    } catch (e) {
        console.error(`⚠️ Failed to download asset ${url}, using original URL. Error:`, e);
        return url;
    }
}

async function prepareDesignAssets(design: any, exportId: string): Promise<any> {
    const processed = JSON.parse(JSON.stringify(design)); // Deep copy
    const assetsDir = join(tmpdir(), exportId, 'assets');

    if (!existsSync(assetsDir)) {
        await mkdir(assetsDir, { recursive: true });
    }

    // Helper to process a list of objects
    const processObjects = async (objects: any[]) => {
        if (!objects) return;
        for (const obj of objects) {
            if (obj.src) {
                // Download everything that looks like a URL
                const localPath = await downloadAsset(obj.src, assetsDir);
                if (localPath && localPath !== obj.src) {
                    obj.src = localPath; // Use absolute local path
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
                if (layers.objects) await processObjects(layers.objects);
                processed.layers = JSON.stringify(layers); // Repack
            } catch (e) {
                console.error('Errors parsing layers during path processing', e);
            }
        } else {
            if (processed.layers.objects) await processObjects(processed.layers.objects);
        }
    }

    if (processed.objects) {
        await processObjects(processed.objects);
    }

    return processed;
}

// Convert absolute paths to valid file:// URLs for the browser
function convertToBrowserPaths(design: any): any {
    const processed = JSON.parse(JSON.stringify(design)); // Deep copy

    const processObjects = (objects: any[]) => {
        if (!objects) return;
        for (const obj of objects) {
            if (obj.src && typeof obj.src === 'string') {
                // If it looks like an absolute path and exists, convert to file URL
                // Simple check for absolute path chars (Unix '/' or Windows 'C:')
                // But better is relying on what processObjects did previously (it put local paths there)
                // We check if it is NOT http/data/blob
                if (!obj.src.startsWith('http') && !obj.src.startsWith('data:') && !obj.src.startsWith('blob:') && !obj.src.startsWith('file:')) {
                    try {
                        obj.src = pathToFileURL(obj.src).href;
                    } catch (e) {
                        console.warn('Failed to convert path to file URL:', obj.src);
                    }
                }
            }
        }
    };

    if (processed.layers) {
        if (typeof processed.layers === 'string') {
            try {
                const layers = JSON.parse(processed.layers);
                if (layers.objects) processObjects(layers.objects);
                processed.layers = JSON.stringify(layers);
            } catch (e) { }
        } else {
            console.log('layers is object');
            if (processed.layers.objects) {
                processObjects(processed.layers.objects);
            }
        }
    }

    if (processed.objects) {
        processObjects(processed.objects);
    }

    return processed;
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

export async function renderVideo(design: any, exportId: string, webhookUrl?: string) {
    const fps = 24; // Smooth video decoding at 24fps
    const baseDir = join(tmpdir(), exportId);
    const framesDir = join(baseDir, 'frames');

    // Create directories
    if (!existsSync(framesDir)) {
        await mkdir(framesDir, { recursive: true });
    }

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--disable-web-security',
            '--no-sandbox', // Often required in containerized/server environments
            '--disable-setuid-sandbox'
        ]
    });

    try {
        // Process design paths - download ALL remote assets to local temp dir
        console.log('Downloading and processing design assets...');
        const localDesign = await prepareDesignAssets(design, exportId);

        // Convert to browser paths (file://) for Puppeteer
        const browserDesign = convertToBrowserPaths(localDesign);

        // 1. Extract Audio FIRST to get its duration
        console.log('Extracting audio...');
        const audioPath = await extractAudio(localDesign, baseDir);
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

        // Extract objects
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
        const duration = Math.max(maxVideoDuration, audioDuration, 5); // Minimum 5s
        console.log(`Final Export Duration: ${duration}s (Audio: ${audioDuration}s, Video: ${maxVideoDuration}s)`);

        const page = await browser.newPage();

        // Enable request interception to serve local videos with Range support
        // This is CRITICAL for maximizing browser performance with local files
        await page.setRequestInterception(true);
        page.on('request', async (request) => {
            const url = request.url();

            // Allow data: and base64 URLs
            if (url.startsWith('data:')) {
                request.continue();
                return;
            }

            // Check if this is a request to one of our downloaded assets
            let localPath: string | null = null;

            if (url.startsWith('file://')) {
                try {
                    const urlObj = new URL(url);
                    if (process.platform === 'win32') {
                        // On Windows, pathname is /D:/... -> remove leading slash to get drive letter D:/...
                        // But Node's new URL handling might already be strict. 
                        // Usually pathToFileURL produces file:///D:/foo
                        // URL.pathname is /D:/foo
                        localPath = urlObj.pathname.substring(1);
                    } else {
                        localPath = urlObj.pathname;
                    }
                    localPath = decodeURI(localPath);
                } catch (e) {
                    console.error('Error parsing file URL:', url, e);
                }
            } else if (existsSync(url)) {
                // It might come as just the path
                localPath = url;
            }

            // Serve local files including Images and Videos
            if (localPath && existsSync(localPath)) {
                try {
                    const ext = extname(localPath).toLowerCase();
                    const isVideo = ['.mp4', '.webm', '.mov', '.mkv'].includes(ext);
                    const fileSize = (await stat(localPath)).size;

                    if (isVideo && request.headers().range) {
                        const range = request.headers().range;
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
                        // Serve full file (Image or full video)
                        const fileHandle = await open(localPath, 'r');
                        const buffer = await fileHandle.readFile();
                        await fileHandle.close();

                        let contentType = 'application/octet-stream';
                        if (ext === '.png') contentType = 'image/png';
                        else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
                        else if (ext === '.svg') contentType = 'image/svg+xml';
                        else if (isVideo) contentType = 'video/mp4';

                        await request.respond({
                            status: 200,
                            contentType: contentType,
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
                    request.continue(); // Fallback to browser handling
                }
            } else {
                request.continue();
            }
        });

        console.log('Navigating to render page...');
        const response = await page.goto('http://localhost:8000/render', {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        console.log('Page loaded with status:', response?.status());

        // Wait for loadDesign function
        await page.waitForFunction(() => typeof (window as any).loadDesign === 'function', { timeout: 10000 });

        // Inject robust seeking function
        await page.evaluate(() => {
            window.__SEEK_VIDEO__ = async (time: number) => {
                const videos = Array.from(document.querySelectorAll('video'));
                if (videos.length === 0) return;

                const seekPromises = videos.map(v => new Promise<void>((resolve) => {
                    if (Math.abs(v.currentTime - time) < 0.05) {
                        resolve(); return;
                    }
                    const onSeeked = () => {
                        v.removeEventListener('seeked', onSeeked);
                        resolve();
                    };
                    setTimeout(() => {
                        v.removeEventListener('seeked', onSeeked);
                        resolve();
                    }, 2000);
                    v.addEventListener('seeked', onSeeked);
                    v.currentTime = time;
                }));

                await Promise.all(seekPromises);
                if (window.__KONVA_STAGE__) window.__KONVA_STAGE__.batchDraw();
            };
        });

        // Load design
        await page.evaluate((d) => {
            (window as any).loadDesign(d);
        }, browserDesign);

        // Wait for ready
        await page.waitForFunction(() => (window as any).designReady === true, { timeout: 60000 });

        console.log(`Capturing frames for ${duration}s...`);
        const totalFrames = Math.floor(duration * fps);
        let successfulSeeks = 0;
        let failedSeeks = 0;

        const reportProgress = async (progress: number, status: string = 'processing') => {
            if (webhookUrl) {
                try {
                    await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ export_id: exportId, progress, status })
                    });
                } catch (e) {
                    console.error('Failed to report progress:', e);
                }
            }
        };

        for (let i = 0; i < totalFrames; i++) {
            const time = i / fps;
            if (i % 5 === 0) reportProgress(Math.round((i / totalFrames) * 100), 'rendering_frames');

            await page.evaluate(async (t) => { await window.__SEEK_VIDEO__(t); }, time);
            await new Promise(resolve => setTimeout(resolve, 50));

            // Check seek accuracy for statistics
            if (i < 5) {
                const accuracy = await page.evaluate((t) => {
                    const v = document.querySelector('video');
                    return v ? Math.abs(v.currentTime - t) : 0;
                }, time);
                if (accuracy < 0.5) successfulSeeks++; else failedSeeks++;
            }

            const dataUrl = await page.evaluate(() => {
                const stage = (window as any).__KONVA_STAGE__;
                return stage.toDataURL({ pixelRatio: 2, mimeType: 'image/png' });
            }) as string;

            const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
            await writeFile(join(framesDir, `frame_${i}.png`), buffer);
            if (i % 30 === 0) console.log(`Saved frame ${i}/${totalFrames}`);
        }

        // FFmpeg Fallback check
        if (failedSeeks > successfulSeeks) {
            console.warn('⚠️ High seek failure rate. Checking for single video fallback...');
            if (designObjects.length === 1 && designObjects[0].type === 'video') {
                // Try ffmpeg extract
                await extractVideoFramesWithFFmpeg(designObjects[0].src, framesDir, fps, duration);
            }
        }

        await reportProgress(90, 'merging_video');
        await mergeVideo(framesDir, audioPath, exportId);

        await reportProgress(95, 'uploading');
        const videoPath = join(baseDir, `${exportId}.mp4`);

        if (existsSync(videoPath)) {
            const formData = new FormData();
            const videoBuffer = await readFile(videoPath);
            const blob = new Blob([videoBuffer], { type: 'video/mp4' });

            formData.append('export_id', exportId);
            formData.append('video', blob, `${exportId}.mp4`);

            const laravelUrl = process.env.LARAVEL_APP_URL || 'http://localhost:8000';
            console.log(`Uploading to ${laravelUrl}...`);

            const uploadRes = await fetch(`${laravelUrl}/export/webhook/store`, {
                method: 'POST', body: formData as any
            });

            if (!uploadRes.ok) throw new Error(`Upload failed: ${await uploadRes.text()}`);
            console.log('✅ Upload successful');
            await reportProgress(100, 'completed');
        } else {
            console.error('Video file missing');
            await reportProgress(100, 'failed');
        }

    } catch (error) {
        console.error('Fatal error in renderVideo:', error);
        throw error;
    } finally {
        await browser.close();
        await cleanupExport(exportId); // STRICT CLEANUP
    }
}
