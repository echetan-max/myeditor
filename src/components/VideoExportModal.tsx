import React, { useState, useRef } from 'react';
import { X, Download, AlertCircle } from 'lucide-react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { ZoomEffect, TextOverlay, getExportInterpolatedZoom } from '../types';

interface VideoExportModalProps {
  videoFile: File;
  zoomEffects: ZoomEffect[];
  textOverlays: TextOverlay[];
  duration: number;
  onClose: () => void;
}

interface ExportSettings {
  quality: '720p' | '1080p' | '1440p' | '2160p';
  fps: 24 | 30 | 60;
  includeAudio: boolean;
}

export const VideoExportModal: React.FC<VideoExportModalProps> = ({
  videoFile,
  zoomEffects,
  textOverlays,
  duration,
  onClose
}) => {
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'processing' | 'complete' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [exportSettings, setExportSettings] = useState<ExportSettings>({
    quality: '1080p',
    fps: 30,
    includeAudio: true
  });
  
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const qualitySettings = {
    '720p': { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    '1440p': { width: 2560, height: 1440 },
    '2160p': { width: 3840, height: 2160 }
  };

  const handleClose = () => {
    if (isExporting && abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsExporting(false);
      setExportStatus('idle');
    }
    onClose();
  };

  const initializeFFmpeg = async (): Promise<FFmpeg> => {
    if (ffmpegRef.current) {
      return ffmpegRef.current;
    }

    const ffmpeg = new FFmpeg();
    ffmpegRef.current = ffmpeg;

    ffmpeg.on('log', ({ message }) => {
      console.log('FFmpeg:', message);
    });

    ffmpeg.on('progress', ({ progress }) => {
      if (progress > 0) {
        setExportProgress(Math.min(80 + (progress * 15), 95)); // Reserve 5% for final processing
      }
    });

    setStatusMessage('Loading FFmpeg...');
    setExportProgress(5);

         const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
     await ffmpeg.load({
       coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
       wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
       workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
     });

    setExportProgress(10);
    return ffmpeg;
  };

  const getFilteredZoomEffects = (): ZoomEffect[] => {
    return [...zoomEffects]
      .filter(z => z.startTime < duration && z.endTime > 0)
      .map(z => ({
        ...z,
        startTime: Math.max(0, Math.min(z.startTime, duration)),
        endTime: Math.max(0, Math.min(z.endTime, duration)),
      }))
      .sort((a, b) => a.startTime - b.startTime);
  };

  const renderVideoFrame = async (
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    time: number,
    targetWidth: number,
    targetHeight: number
  ): Promise<void> => {
    // Set video time and wait for seek
    video.currentTime = time;
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
    });

    // Clear canvas
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    
    // Get current zoom effect
    const filteredZooms = getFilteredZoomEffects();
    const currentZoom = getExportInterpolatedZoom(time, filteredZooms);
    
    // Calculate zoom transformation (matching VideoPlayer logic)
    const scale = Math.max(1.0, Math.min(currentZoom.scale, 5.0));
    const offsetX = (50 - currentZoom.x) * (scale - 1);
    const offsetY = (50 - currentZoom.y) * (scale - 1);
    
    // Apply transformations
    ctx.save();
    ctx.translate(targetWidth / 2, targetHeight / 2);
    ctx.scale(scale, scale);
    ctx.translate((offsetX * targetWidth) / 100, (offsetY * targetHeight) / 100);
    
    // Draw video frame
    const videoAspect = video.videoWidth / video.videoHeight;
    const canvasAspect = targetWidth / targetHeight;
    
    let drawWidth = targetWidth;
    let drawHeight = targetHeight;
    
    if (videoAspect > canvasAspect) {
      drawHeight = targetWidth / videoAspect;
    } else {
      drawWidth = targetHeight * videoAspect;
    }
    
    ctx.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();

    // Render text overlays
    const activeOverlays = textOverlays.filter(overlay => 
      time >= overlay.startTime && time <= overlay.endTime
    );

    for (const overlay of activeOverlays) {
      ctx.save();
      
      // Set font properties
      const fontSize = Math.max(12, (overlay.fontSize || 24) * (targetHeight / 1080));
      const fontFamily = overlay.fontFamily || 'Arial, sans-serif';
      ctx.font = `bold ${fontSize}px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      // Calculate position
      const x = (overlay.x / 100) * targetWidth;
      const y = (overlay.y / 100) * targetHeight;
      
      // Draw background if specified
      if (overlay.backgroundColor && overlay.backgroundColor !== 'transparent') {
        const padding = (overlay.padding || 0) * (targetHeight / 1080);
        const borderRadius = (overlay.borderRadius || 0) * (targetHeight / 1080);
        
        const textMetrics = ctx.measureText(overlay.text);
        const bgWidth = textMetrics.width + (padding * 2);
        const bgHeight = fontSize + (padding * 2);
        
        ctx.fillStyle = overlay.backgroundColor;
        
                 if (borderRadius > 0) {
           // Create rounded rectangle manually for better browser compatibility
           ctx.beginPath();
           const rectX = x - bgWidth / 2;
           const rectY = y - bgHeight / 2;
           ctx.moveTo(rectX + borderRadius, rectY);
           ctx.lineTo(rectX + bgWidth - borderRadius, rectY);
           ctx.quadraticCurveTo(rectX + bgWidth, rectY, rectX + bgWidth, rectY + borderRadius);
           ctx.lineTo(rectX + bgWidth, rectY + bgHeight - borderRadius);
           ctx.quadraticCurveTo(rectX + bgWidth, rectY + bgHeight, rectX + bgWidth - borderRadius, rectY + bgHeight);
           ctx.lineTo(rectX + borderRadius, rectY + bgHeight);
           ctx.quadraticCurveTo(rectX, rectY + bgHeight, rectX, rectY + bgHeight - borderRadius);
           ctx.lineTo(rectX, rectY + borderRadius);
           ctx.quadraticCurveTo(rectX, rectY, rectX + borderRadius, rectY);
           ctx.closePath();
           ctx.fill();
         } else {
           ctx.fillRect(x - bgWidth / 2, y - bgHeight / 2, bgWidth, bgHeight);
         }
        
        // Add shadow for background
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 8 * (targetHeight / 1080);
        ctx.shadowOffsetX = 2 * (targetHeight / 1080);
        ctx.shadowOffsetY = 2 * (targetHeight / 1080);
      }
      
      // Draw text with shadow
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 4 * (targetHeight / 1080);
      ctx.shadowOffsetX = 2 * (targetHeight / 1080);
      ctx.shadowOffsetY = 2 * (targetHeight / 1080);
      
      ctx.fillStyle = overlay.color || '#ffffff';
      ctx.fillText(overlay.text, x, y);
      
      ctx.restore();
    }
  };

  const handleExport = async () => {
    if (isExporting) return;
    
    setIsExporting(true);
    setExportStatus('loading');
    setExportProgress(0);
    setStatusMessage('Initializing export...');
    
    const controller = new AbortController();
    abortControllerRef.current = controller;
    
    try {
      // Initialize FFmpeg
      const ffmpeg = await initializeFFmpeg();
      
      if (controller.signal.aborted) throw new Error('Export cancelled');
      
      setStatusMessage('Preparing video...');
      setExportProgress(15);
      
      // Create video element for frame extraction
      const video = document.createElement('video');
      video.src = URL.createObjectURL(videoFile);
      video.muted = true;
      video.playsInline = true;
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Video load timeout')), 10000);
        video.onloadedmetadata = () => {
          clearTimeout(timeout);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('Failed to load video'));
        };
      });
      
      if (controller.signal.aborted) throw new Error('Export cancelled');
      
      // Setup canvas for rendering
      const { width: targetWidth, height: targetHeight } = qualitySettings[exportSettings.quality];
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d')!;
      
      setStatusMessage('Rendering frames...');
      setExportStatus('processing');
      
      // Calculate frame parameters
      const fps = exportSettings.fps;
      const totalFrames = Math.ceil(duration * fps);
      const frameInterval = 1 / fps;
      
             // Render frames in batches for better performance
       const batchSize = 10;
       const totalBytes = targetWidth * targetHeight * 4 * totalFrames;
       const rawVideoData = new Uint8Array(totalBytes);
       let dataOffset = 0;
       
       for (let batchStart = 0; batchStart < totalFrames; batchStart += batchSize) {
         if (controller.signal.aborted) throw new Error('Export cancelled');
         
         const batchEnd = Math.min(batchStart + batchSize, totalFrames);
         
         for (let frame = batchStart; frame < batchEnd; frame++) {
           const time = frame * frameInterval;
           
           try {
             await renderVideoFrame(video, canvas, ctx, time, targetWidth, targetHeight);
             
             // Convert canvas to raw video frame
             const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
             rawVideoData.set(new Uint8Array(imageData.data.buffer), dataOffset);
             dataOffset += imageData.data.buffer.byteLength;
             
           } catch (error) {
             console.warn(`Error rendering frame ${frame}:`, error);
             // Fill with black frame if rendering fails
             const blackFrame = new Uint8Array(targetWidth * targetHeight * 4);
             for (let i = 3; i < blackFrame.length; i += 4) {
               blackFrame[i] = 255; // Alpha channel
             }
             rawVideoData.set(blackFrame, dataOffset);
             dataOffset += blackFrame.length;
           }
         }
         
         // Update progress for frame rendering (15% to 60%)
         const frameProgress = 15 + ((batchEnd / totalFrames) * 45);
         setExportProgress(frameProgress);
         setStatusMessage(`Rendering frames... ${batchEnd}/${totalFrames}`);
         
         // Allow UI to update
         await new Promise(resolve => setTimeout(resolve, 1));
       }
      
      if (controller.signal.aborted) throw new Error('Export cancelled');
      
      setStatusMessage('Processing with FFmpeg...');
      setExportProgress(65);
      
             // Write original video to FFmpeg filesystem
       await ffmpeg.writeFile('input.mp4', await fetchFile(videoFile));
       
       // Write the rendered frames to FFmpeg filesystem
       await ffmpeg.writeFile('frames.rgba', rawVideoData);
      
      if (controller.signal.aborted) throw new Error('Export cancelled');
      
             // Build FFmpeg command with optimized settings
       const ffmpegArgs = [
         '-f', 'rawvideo',
         '-pix_fmt', 'rgba',
         '-s', `${targetWidth}x${targetHeight}`,
         '-r', fps.toString(),
         '-i', 'frames.rgba',
       ];
       
       if (exportSettings.includeAudio) {
         ffmpegArgs.push(
           '-i', 'input.mp4',
           '-c:a', 'aac',
           '-b:a', '128k',
           '-map', '0:v:0',
           '-map', '1:a:0?'
         );
       }
       
       // Video encoding settings optimized for web
       ffmpegArgs.push(
         '-c:v', 'libx264',
         '-preset', 'faster', // Faster encoding for better user experience
         '-crf', '23',
         '-pix_fmt', 'yuv420p',
         '-profile:v', 'baseline', // Better compatibility
         '-level', '3.0',
         '-movflags', '+faststart',
         '-avoid_negative_ts', 'make_zero',
         'output.mp4'
       );
      
      setStatusMessage('Encoding video...');
      await ffmpeg.exec(ffmpegArgs);
      
      if (controller.signal.aborted) throw new Error('Export cancelled');
      
      setStatusMessage('Finalizing...');
      setExportProgress(95);
      
      // Read the output file
      const outputData = await ffmpeg.readFile('output.mp4');
      const outputBlob = new Blob([outputData], { type: 'video/mp4' });
      
      // Clean up FFmpeg files
      try {
        await ffmpeg.deleteFile('input.mp4');
        await ffmpeg.deleteFile('frames.rgba');
        await ffmpeg.deleteFile('output.mp4');
      } catch (e) {
        console.warn('Failed to clean up FFmpeg files:', e);
      }
      
      // Download the file
      const url = URL.createObjectURL(outputBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `exported_video_${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setExportProgress(100);
      setExportStatus('complete');
      setStatusMessage('Export completed successfully!');
      
    } catch (error) {
      console.error('Export error:', error);
      setExportStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Export failed');
      setExportProgress(0);
    } finally {
      setIsExporting(false);
      abortControllerRef.current = null;
    }
  };

  const getProgressColor = () => {
    switch (exportStatus) {
      case 'complete': return 'bg-green-500';
      case 'error': return 'bg-red-500';
      default: return 'bg-gradient-to-r from-purple-600 to-blue-500';
    }
  };

  const getStatusIcon = () => {
    switch (exportStatus) {
      case 'complete': return '✓';
      case 'error': return <AlertCircle className="w-4 h-4" />;
      default: return null;
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <h3 className="text-lg font-semibold text-white">Export Video</h3>
          <button 
            onClick={handleClose} 
            className="text-gray-400 hover:text-white transition-colors"
            disabled={isExporting}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-6 space-y-6">
          {/* Export Settings */}
          {!isExporting && exportStatus === 'idle' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Quality
                </label>
                <select
                  value={exportSettings.quality}
                  onChange={(e) => setExportSettings(prev => ({ 
                    ...prev, 
                    quality: e.target.value as ExportSettings['quality'] 
                  }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white focus:outline-none focus:border-purple-500"
                >
                  <option value="720p">720p (1280x720)</option>
                  <option value="1080p">1080p (1920x1080)</option>
                  <option value="1440p">1440p (2560x1440)</option>
                  <option value="2160p">4K (3840x2160)</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Frame Rate
                </label>
                <select
                  value={exportSettings.fps}
                  onChange={(e) => setExportSettings(prev => ({ 
                    ...prev, 
                    fps: parseInt(e.target.value) as ExportSettings['fps'] 
                  }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white focus:outline-none focus:border-purple-500"
                >
                  <option value={24}>24 FPS</option>
                  <option value={30}>30 FPS</option>
                  <option value={60}>60 FPS</option>
                </select>
              </div>
              
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="includeAudio"
                  checked={exportSettings.includeAudio}
                  onChange={(e) => setExportSettings(prev => ({ 
                    ...prev, 
                    includeAudio: e.target.checked 
                  }))}
                  className="mr-2 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
                />
                <label htmlFor="includeAudio" className="text-sm text-gray-300">
                  Include original audio
                </label>
              </div>
              
                             <div className="bg-gray-700 rounded-lg p-4">
                 <h4 className="text-sm font-medium text-white mb-2">Export Summary</h4>
                 <div className="text-sm text-gray-300 space-y-1">
                   <div>Duration: {duration.toFixed(1)}s</div>
                   <div>Zoom Effects: {getFilteredZoomEffects().length}</div>
                   <div>Text Overlays: {textOverlays.length}</div>
                   <div>Resolution: {qualitySettings[exportSettings.quality].width}x{qualitySettings[exportSettings.quality].height}</div>
                   <div>Estimated Size: ~{Math.ceil(duration * 2)} MB</div>
                 </div>
               </div>
            </div>
          )}
          
          {/* Progress Display */}
          {(isExporting || exportStatus !== 'idle') && (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm text-gray-300">
                <div className="flex items-center space-x-2">
                  {getStatusIcon()}
                  <span>{statusMessage}</span>
                </div>
                <span>{exportProgress.toFixed(0)}%</span>
              </div>
              
              <div className="w-full bg-gray-600 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all duration-300 ${getProgressColor()}`}
                  style={{ width: `${exportProgress}%` }}
                />
              </div>
              
              {exportStatus === 'error' && (
                <div className="bg-red-500 bg-opacity-20 border border-red-500 rounded-lg p-3">
                  <p className="text-red-100 text-sm">
                    Export failed. Please try again or check your browser's console for more details.
                  </p>
                </div>
              )}
              
              {exportStatus === 'complete' && (
                <div className="bg-green-500 bg-opacity-20 border border-green-500 rounded-lg p-3">
                  <p className="text-green-100 text-sm">
                    Video exported successfully! The download should start automatically.
                  </p>
                </div>
              )}
            </div>
          )}
          
          {/* Action Buttons */}
          <div className="flex justify-end space-x-3">
            <button
              onClick={handleClose}
              className="px-4 py-2 bg-gray-700 text-white rounded-md hover:bg-gray-600 transition-colors"
              disabled={isExporting}
            >
              {exportStatus === 'complete' ? 'Close' : 'Cancel'}
            </button>
            
            {exportStatus !== 'complete' && (
              <button
                onClick={handleExport}
                disabled={isExporting}
                className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {isExporting ? (
                  <>
                    <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                    <span>Exporting...</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>Export MP4</span>
                  </>
                )}
              </button>
            )}
            
            {exportStatus === 'error' && (
              <button
                onClick={() => {
                  setExportStatus('idle');
                  setStatusMessage('');
                  setExportProgress(0);
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};