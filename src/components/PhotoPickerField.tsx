import { useRef } from 'react';
import type { ReactElement } from 'react';
import { useT } from '../i18n';
import { addBtn } from '../lib/uiClasses';
import { MemoryBlobImage, StoredPhotoImage } from './BlobImage';

function PhotoThumb({
  photoId,
  file,
  removeLabel,
  onRemove,
}: {
  photoId?: string;
  file?: File;
  removeLabel: string;
  onRemove: () => void;
}): ReactElement {
  return (
    <li className="relative">
      <div className="h-24 w-24 overflow-hidden rounded-xl bg-surface-muted shadow-sm">
        {file ? (
          <MemoryBlobImage blob={file} alt="" className="h-full w-full object-cover" />
        ) : (
          <StoredPhotoImage photoId={photoId} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-xs text-page hover:opacity-80 active:opacity-80"
      >
        ✕
      </button>
    </li>
  );
}

/**
 * Stored photos plus newly picked files. Picked files stay raw here; the form
 * encodes them on submit, and `onPick` is responsible for capping at `max`.
 */
export default function PhotoPickerField({
  label,
  hint,
  max,
  removeLabel,
  photoIds,
  picked,
  onPick,
  onRemoveStored,
  onRemovePicked,
}: {
  label: string;
  hint?: string;
  max: number;
  removeLabel?: string;
  photoIds: string[];
  picked: File[];
  onPick: (files: File[]) => void;
  onRemoveStored: (id: string) => void;
  onRemovePicked: (index: number) => void;
}): ReactElement {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const remaining = max - photoIds.length - picked.length;
  const photoRemoveLabel = removeLabel ?? t('common.removePhoto');

  return (
    <div className="mt-6">
      <h2 className="text-lg font-semibold">{label}</h2>
      {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length > 0) onPick(files);
          e.target.value = '';
        }}
      />
      {(photoIds.length > 0 || picked.length > 0) && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {photoIds.map((id) => (
            <PhotoThumb
              key={id}
              photoId={id}
              removeLabel={photoRemoveLabel}
              onRemove={() => onRemoveStored(id)}
            />
          ))}
          {picked.map((file, i) => (
            <PhotoThumb
              key={`picked-${file.name}-${file.size}-${file.lastModified}`}
              file={file}
              removeLabel={photoRemoveLabel}
              onRemove={() => onRemovePicked(i)}
            />
          ))}
        </ul>
      )}
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`mt-2 block ${addBtn}`}
        >
          {t('form.addPhoto')}
        </button>
      )}
    </div>
  );
}
