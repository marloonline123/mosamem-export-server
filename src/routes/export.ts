import { Router } from 'express';
import { renderVideo } from '../renderer/captureFrames';
import { renderVideoWithFFmpeg } from '../renderer/ffmpegRenderer';

const router = Router();

router.post('/', async (req, res) => {
    const { design, exportId } = req.body;

    console.log('recived request from laravel: ', exportId);
    console.log('Design data structure:', {
        hasDesign: !!design,
        designKeys: design ? Object.keys(design) : 'no design',
        hasCanvas: !!(design?.canvas),
        hasObjects: !!(design?.objects),
        objectsLength: design?.objects?.length || 0,
        designSample: design ? JSON.stringify(design).substring(0, 200) + '...' : 'no design'
    });

    // Add detailed logging for Laravel fields
    if (design) {
        console.log('Laravel specific fields:');
        console.log('- canvas_config type:', typeof design.canvas_config);
        console.log('- canvas_config sample:', design.canvas_config ? String(design.canvas_config).substring(0, 100) + '...' : 'null');
        console.log('- layers type:', typeof design.layers);
        console.log('- layers sample:', design.layers ? String(design.layers).substring(0, 100) + '...' : 'null');
    }

    // Choose renderer based on query parameter
    const useFFmpeg = req.query.ffmpeg === 'true';
    console.log('🎬 Using renderer:', useFFmpeg ? 'FFmpeg' : 'Puppeteer');

    res.json({
        status: 'started',
        renderer: useFFmpeg ? 'ffmpeg' : 'puppeteer'
    });

    try {
        if (useFFmpeg) {
            await renderVideoWithFFmpeg(design, exportId);
        } else {
            const { webhook_url } = req.body;
            await renderVideo(design, exportId, webhook_url);
        }
        console.log('✅ Export completed successfully');
    } catch (error) {
        console.error('❌ Export failed:', error);
    }
});

export default router;
