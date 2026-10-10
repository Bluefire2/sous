import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { clearPublicReturn, readPublicReturn } from '../lib/publicApi';

/**
 * `/p`: where sign-in from a public page lands. The token waited in this
 * tab's sessionStorage (it never rode the OAuth round trip); go back to that
 * collection, or to the library when there is none.
 */
export default function PublicReturn() {
  const [token] = useState(readPublicReturn);
  useEffect(() => {
    clearPublicReturn();
  }, []);
  return <Navigate to={token === null ? '/' : `/p/${encodeURIComponent(token)}`} replace />;
}
