import { useRef, useState, useCallback, useEffect, DragEvent, ChangeEvent } from 'react';
import { UploadIcon, CheckIcon, ImageIcon, CameraIcon } from './icons';

interface Props {
  onFileSelect: (file: File) => void;
  selectedFile: File | null;
  previewUrl: string | null;
  disabled: boolean;
}

const isMobile = () => navigator.maxTouchPoints > 0;

export default function ImageUpload({ onFileSelect, selectedFile, previewUrl, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const nativeCameraRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [dragging, setDragging] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [captured, setCaptured] = useState<string | null>(null);

  const handleFile = useCallback(
    (file: File) => {
      const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowed.includes(file.type)) return;
      onFileSelect(file);
    },
    [onFileSelect]
  );

  // ── drag-and-drop ──────────────────────────────────────────
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!disabled) setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  };

  // ── camera helpers ─────────────────────────────────────────
  const startCamera = async () => {
    if (isMobile()) {
      nativeCameraRef.current?.click();
      return;
    }
    setCameraError('');
    setCaptured(null);
    setCameraOpen(true);
  };

  useEffect(() => {
    if (!cameraOpen) return;

    let active = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (err: unknown) {
        if (!active) return;
        const msg = err instanceof DOMException
          ? err.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access and try again.'
            : err.name === 'NotFoundError'
            ? 'No camera found on this device.'
            : `Camera error: ${err.message}`
          : 'Could not open camera.';
        setCameraError(msg);
      }
    })();

    return () => { active = false; };
  }, [cameraOpen]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCameraOpen(false);
    setCaptured(null);
    setCameraError('');
  }, []);

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    setCaptured(dataUrl);
  };

  const retake = () => setCaptured(null);

  const usePhoto = () => {
    if (!captured) return;
    const byteStr = atob(captured.split(',')[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const file = new File([arr], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' });
    onFileSelect(file);
    stopCamera();
  };

  // ── render ─────────────────────────────────────────────────
  return (
    <>
      <div className="upload-grid" style={{ gridTemplateColumns: (previewUrl && !isMobile()) ? '1fr 1fr' : '1fr' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Drop zone */}
        <div
          onClick={() => !disabled && inputRef.current?.click()}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          style={{
            border: `2px dashed ${dragging ? 'var(--accent)' : selectedFile ? 'var(--success)' : 'var(--border)'}`,
            borderRadius: 'var(--radius)',
            padding: '32px 24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '10px',
            cursor: disabled ? 'not-allowed' : 'pointer',
            background: dragging ? 'var(--accent-light)' : selectedFile ? 'var(--success-light)' : 'var(--surface-2)',
            transition: 'all 0.2s ease',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
            style={{ display: 'none' }}
            onChange={onChange}
            disabled={disabled}
          />

          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: selectedFile ? 'var(--success-light)' : 'var(--accent-light)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {selectedFile ? <CheckIcon color="var(--success)" /> : <UploadIcon color="var(--accent)" />}
          </div>

          {selectedFile ? (
            <>
              <p style={{ fontWeight: 600, color: 'var(--success)', fontSize: '15px' }}>Image ready</p>
              <p style={{
                fontSize: '13px', color: 'var(--text-secondary)', textAlign: 'center',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                maxWidth: '100%',
              }}>
                {selectedFile.name}
              </p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {(selectedFile.size / 1024).toFixed(0)} KB
              </p>
              {!disabled && <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Click to replace</p>}
            </>
          ) : (
            <>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '15px' }}>
                Drop your invoice here
              </p>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', textAlign: 'center' }}>
                or <span style={{ color: 'var(--accent)', fontWeight: 500 }}>browse files</span>
              </p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>JPEG, PNG, WebP, GIF — max 10 MB</p>
            </>
          )}
        </div>

        <input
          ref={nativeCameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={onChange}
          disabled={disabled}
        />

        {/* Camera button */}
        <button
          onClick={startCamera}
          disabled={disabled}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '10px 16px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface)',
            color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
            fontSize: '13px', fontWeight: 500,
            cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; }}
        >
          <CameraIcon color={disabled ? 'var(--text-muted)' : 'var(--text-secondary)'} />
          Use Camera
        </button>

        </div>

        {/* Image preview — right column */}
        {previewUrl && (
          <div style={{
            borderRadius: 'var(--radius)', overflow: 'hidden',
            border: '1px solid var(--border)', background: 'var(--surface)', boxShadow: 'var(--shadow-sm)',
          }}>
            <div style={{
              padding: '10px 14px', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)',
            }}>
              <ImageIcon color="var(--text-secondary)" size={16} />
              <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>Preview</span>
            </div>
            <img
              src={previewUrl}
              alt="Invoice preview"
              style={{ width: '100%', maxHeight: '480px', objectFit: 'contain', display: 'block', background: '#f9fafb' }}
            />
          </div>
        )}
      </div>

      {/* Camera modal */}
      {cameraOpen && (
        <div
          onClick={stopCamera}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#111', borderRadius: 16, overflow: 'hidden',
              width: '100%', maxWidth: 720,
              boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
              display: 'flex', flexDirection: 'column',
            }}
          >
            {/* Modal header */}
            <div style={{
              padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CameraIcon color="#fff" />
                <span style={{ color: '#fff', fontWeight: 600, fontSize: '14px' }}>Take Photo</span>
              </div>
              <button
                onClick={stopCamera}
                style={{
                  background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
                  width: 32, height: 32, cursor: 'pointer', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '18px', lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>

            {/* Camera error */}
            {cameraError && (
              <div style={{ padding: '40px 24px', textAlign: 'center' }}>
                <p style={{ color: '#f87171', fontSize: '14px', lineHeight: 1.6 }}>{cameraError}</p>
                <button
                  onClick={stopCamera}
                  style={{
                    marginTop: 16, padding: '8px 20px', borderRadius: 8,
                    background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
                    color: '#fff', cursor: 'pointer', fontSize: '13px',
                  }}
                >
                  Close
                </button>
              </div>
            )}

            {/* Video / captured preview */}
            {!cameraError && (
              <div style={{ position: 'relative', background: '#000', aspectRatio: '16/9' }}>
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  style={{
                    width: '100%', height: '100%', objectFit: 'cover', display: 'block',
                    opacity: captured ? 0 : 1, transition: 'opacity 0.2s',
                  }}
                />
                {captured && (
                  <img
                    src={captured}
                    alt="Captured"
                    style={{
                      position: 'absolute', inset: 0, width: '100%', height: '100%',
                      objectFit: 'cover', display: 'block',
                    }}
                  />
                )}
              </div>
            )}

            {/* Controls */}
            {!cameraError && (
              <div style={{
                padding: '16px 20px', display: 'flex', gap: 10, justifyContent: 'center',
                borderTop: '1px solid rgba(255,255,255,0.08)',
              }}>
                {!captured ? (
                  <button
                    onClick={capturePhoto}
                    style={{
                      width: 60, height: 60, borderRadius: '50%',
                      background: '#fff', border: '4px solid rgba(255,255,255,0.3)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: '0 0 0 3px rgba(255,255,255,0.15)',
                      transition: 'transform 0.1s',
                    }}
                    onMouseDown={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.92)'; }}
                    onMouseUp={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; }}
                    title="Capture photo"
                  >
                    <div style={{ width: 46, height: 46, borderRadius: '50%', background: '#fff', border: '3px solid #111' }} />
                  </button>
                ) : (
                  <>
                    <button
                      onClick={retake}
                      style={{
                        padding: '10px 24px', borderRadius: 8,
                        background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
                        color: '#fff', cursor: 'pointer', fontSize: '14px', fontWeight: 500,
                      }}
                    >
                      Retake
                    </button>
                    <button
                      onClick={usePhoto}
                      style={{
                        padding: '10px 28px', borderRadius: 8,
                        background: 'var(--accent)', border: 'none',
                        color: '#fff', cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                        boxShadow: '0 4px 12px rgba(37,99,235,0.4)',
                      }}
                    >
                      Use this photo
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
