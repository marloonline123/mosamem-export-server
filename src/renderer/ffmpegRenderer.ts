import { spawn } from 'child_process';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

interface MediaElement {
    type: 'video' | 'image' | 'text';
    src?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    startTime?: number;
    endTime?: number;
    text?: string;
    fontSize?: number;
    color?: string;
}

export async function renderVideoWithFFmpeg(design: any, exportId: string): Promise<string> {
    console.log('🎬 Starting FFmpeg-based video export...');
    
    try {
        // Extract media elements from design
        const mediaElements = extractMediaElements(design);
        const canvas = getCanvasConfig(design);
        
        console.log('📊 Export info:', {
            elements: mediaElements.length,
            canvas: { width: canvas.width, height: canvas.height }
        });
        
        // Find video elements to determine duration and get audio
        const videoElements = mediaElements.filter(e => e.type === 'video' && e.src);
        
        if (videoElements.length === 0) {
            throw new Error('No video elements found in design');
        }
        
        const primaryVideo = videoElements[0];
        const outputPath = join('storage', 'exports', 'videos', `${exportId}.mp4`);
        
        // Simple approach: Use the first video as base and overlay other elements
        const command = [
            'ffmpeg', '-y',
            '-i', primaryVideo.src!, // Primary video input
            '-vf', buildVideoFilters(mediaElements, canvas),
            '-c:v', 'libx264',
            '-c:a', 'copy', // Copy audio from source
            '-pix_fmt', 'yuv420p',
            outputPath
        ];
        
        console.log('🔧 FFmpeg command:', command.join(' '));
        
        // Execute FFmpeg
        await executeFFmpeg(command);
        
        console.log('✅ Video export completed:', outputPath);
        return outputPath;
        
    } catch (error) {
        console.error('❌ FFmpeg export failed:', error);
        throw error;
    }
}

function extractMediaElements(design: any): MediaElement[] {
    const elements: MediaElement[] = [];
    
    // Parse design data
    let objects = [];
    if (design.layers) {
        const parsed = typeof design.layers === 'string' ? JSON.parse(design.layers) : design.layers;
        objects = parsed.objects || [];
    } else {
        objects = design.objects || [];
    }
    
    console.log('📋 Processing', objects.length, 'design objects');
    
    // Convert to media elements
    for (const obj of objects) {
        if (obj.visible === false) continue;
        
        const element: MediaElement = {
            type: obj.customType || obj.type,
            x: obj.x || 0,
            y: obj.y || 0,
            width: obj.width || 100,
            height: obj.height || 100,
        };
        
        if (obj.src) {
            element.src = obj.src;
            console.log('📎 Found media:', element.type, obj.src.substring(obj.src.lastIndexOf('/') + 1));
        }
        
        if (obj.text) {
            element.text = obj.text;
            element.fontSize = obj.fontSize || 24;
            element.color = obj.fill || '#000000';
            console.log('📝 Found text:', obj.text.substring(0, 50));
        }
        
        elements.push(element);
    }
    
    return elements;
}

function getCanvasConfig(design: any): { width: number; height: number; backgroundColor?: string } {
    let canvas;
    
    if (design.layers) {
        const parsed = typeof design.layers === 'string' ? JSON.parse(design.layers) : design.layers;
        canvas = parsed.canvas;
    } else {
        canvas = design.canvas;
    }
    
    return {
        width: canvas?.width || 1920,
        height: canvas?.height || 1080,
        backgroundColor: canvas?.backgroundColor || '#ffffff'
    };
}

function buildVideoFilters(elements: MediaElement[], canvas: any): string {
    const filters: string[] = [];
    
    // Start with scaling the main video to canvas size
    filters.push(`scale=${canvas.width}:${canvas.height}`);
    
    // For now, just return basic scaling
    // In a full implementation, you'd add overlays for images and text
    console.log('🎨 Using basic video scaling filter');
    
    return filters.join(',');
}

function executeFFmpeg(command: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        console.log('🚀 Executing FFmpeg...');
        
        const process = spawn(command[0], command.slice(1), {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        
        process.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        process.stderr.on('data', (data) => {
            stderr += data.toString();
            // FFmpeg outputs progress to stderr
            if (data.toString().includes('frame=')) {
                console.log('.');
            }
        });
        
        process.on('close', (code) => {
            console.log(''); // New line after progress dots
            
            if (code === 0) {
                console.log('✅ FFmpeg completed successfully');
                resolve();
            } else {
                console.error('❌ FFmpeg failed with code:', code);
                console.error('stderr:', stderr);
                reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
            }
        });
        
        process.on('error', (error) => {
            console.error('❌ FFmpeg process error:', error);
            reject(error);
        });
    });
}