import { execSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

export function mergeVideo(framesDir: string, audio: string | null, exportId: string) {
    // Relative to export-server: ../main/storage/app/public/exports
    const outputDir = join('..', 'main', 'storage', 'app', 'public', 'exports', 'videos');
    const output = join(outputDir, `${exportId}.mp4`);

    // Create output directory if it doesn't exist
    if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
        console.log('Created output directory:', outputDir);
    }

    const audioCmd = audio ? `-i "${audio}"` : '';

    try {
        console.log('Merging video frames from:', framesDir);
        console.log('Audio file:', audio || 'none');
        console.log('Output file:', output);

        const command = `ffmpeg -y -framerate 24 -i "${framesDir}/frame_%d.png" ${audioCmd} -c:v libx264 -pix_fmt yuv420p -r 24 "${output}"`;

        console.log('FFmpeg command:', command);
        execSync(command);

        console.log('Video export completed:', output);
    } catch (error) {
        console.error('FFmpeg error:', error);
        throw error;
    }
}
