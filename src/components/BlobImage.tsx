import { useEffect, useState } from 'react';
import type { ImgHTMLAttributes } from 'react';
import { selectPendingBlob } from '../lib/librarySelectors';
import { photoStore } from '../lib/photoStore';
import { useLibrarySelect } from '../lib/useLibrary';

type MemoryBlobImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  blob: Blob | undefined;
};

function readImageDataUrl(blob: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.startsWith('data:image/')) {
        resolve(undefined);
        return;
      }
      resolve(result);
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(blob);
  });
}

/**
 * Renders a photo preview from an in-memory blob (picked file or fetched bytes).
 * Previews use a `data:` URL from FileReader, not object URLs or request text.
 */
export function MemoryBlobImage({ blob, alt, className, ...rest }: MemoryBlobImageProps) {
  const [dataUrl, setDataUrl] = useState<string>();

  useEffect(() => {
    if (blob === undefined) {
      setDataUrl(undefined);
      return;
    }
    let cancelled = false;
    void readImageDataUrl(blob).then((url) => {
      if (!cancelled) {
        setDataUrl(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [blob]);

  if (blob === undefined || dataUrl === undefined) {
    return null;
  }

  return <img src={dataUrl} alt={alt} className={className} {...rest} />;
}

type StoredPhotoImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  photoId: string | undefined;
};

/** Photo already in the library session (pending upload or fetched from the server). */
export function StoredPhotoImage({ photoId, ...rest }: StoredPhotoImageProps) {
  const blob = useLibrarySelect(selectPendingBlob(photoId));
  useEffect(() => {
    if (photoId) {
      void photoStore.ensureLocal(photoId);
    }
  }, [photoId]);
  return <MemoryBlobImage blob={blob} {...rest} />;
}
