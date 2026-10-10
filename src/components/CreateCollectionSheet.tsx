import Sheet from './Sheet';
import { useT } from '../i18n';
import { inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';

/** The name field for a new collection. Both library screens open this sheet. */
export default function CreateCollectionSheet({
  name,
  saving,
  error,
  onName,
  onSubmit,
  onClose,
}: {
  name: string;
  saving: boolean;
  error: string | undefined;
  onName: (name: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Sheet onClose={onClose}>
      <h2 className="text-lg font-semibold">{t('common.newCollection')}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <input
          autoFocus
          value={name}
          disabled={saving}
          onChange={(event) => onName(event.target.value)}
          placeholder={t('common.name')}
          className={`${inputClass} mt-3 disabled:opacity-60`}
        />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <button
          type="submit"
          disabled={name.trim() === '' || saving}
          className={`${primaryBtn} mt-3 w-full py-3`}
        >
          {t('library.create')}
        </button>
        <button type="button" onClick={onClose} className={`${secondaryBtn} mt-2 w-full py-3`}>
          {t('common.cancel')}
        </button>
      </form>
    </Sheet>
  );
}
