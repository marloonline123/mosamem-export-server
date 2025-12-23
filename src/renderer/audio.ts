import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

export async function extractAudio(design: any, outputDir?: string) {
    console.log('=== Audio extraction started ===');
    console.log('Design data exists:', !!design);

    if (!design) {
        console.log('No design data provided for audio extraction');
        return null;
    }

    console.log('Design keys:', Object.keys(design));

    let objects;

    // Handle Laravel data structure - the layers field contains the full design JSON
    if (design.layers) {
        console.log('Processing Laravel layers field for audio');
        // console.log('Layers type:', typeof design.layers);

        try {
            let parsedData;
            if (typeof design.layers === 'string') {
                // console.log('Parsing layers as JSON string...');
                parsedData = JSON.parse(design.layers);
            } else {
                // console.log('Using layers as object...');
                parsedData = design.layers;
            }

            // console.log('Parsed data keys:', Object.keys(parsedData));
            objects = parsedData.objects || [];
            console.log('Extracted objects for audio:', objects.length, 'items');

        } catch (e) {
            console.error('Failed to parse layers for audio extraction:', e);
            return null;
        }
    } else if (design.objects && Array.isArray(design.objects)) {
        console.log('Using design.objects array');
        objects = design.objects;
    } else {
        console.log('No objects or layers found in design data');
        return null;
    }

    if (!objects || !Array.isArray(objects)) {
        console.log('Objects is not an array:', typeof objects);
        return null;
    }

    console.log('Searching for video in', objects.length, 'objects');

    const videoObj = objects.find((o: any) => {
        const elementType = o.customType || o.type;
        return elementType === 'video';
    });

    if (!videoObj) {
        console.log('No video object found in design');
        return null;
    }

    console.log('Found video object:', {
        type: videoObj.type,
        src: videoObj.src ? 'exists' : 'missing',
        muted: videoObj.muted
    });

    if (videoObj.muted) {
        console.log('Video is muted in design, but extracting audio anyway for export');
        // Continue with audio extraction even if muted in design
    }

    if (!videoObj.src) {
        console.log('Video object has no source');
        return null;
    }

    const dir = outputDir || tmpdir();
    // Using a simpler name but assuming dir is unique if passed
    const output = join(dir, 'audio.aac');

    try {
        console.log('Extracting audio from:', videoObj.src);
        execSync(`ffmpeg -y -i "${videoObj.src}" -vn -acodec copy "${output}"`);
        console.log('Audio extracted to:', output);
        return output;
    } catch (error) {
        console.error('Failed to extract audio:', error);
        return null;
    }
}
