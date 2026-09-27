import { create } from 'zustand'

/** The active workspace pairing code stays in renderer memory only. A single
 *  monotonically increasing request version rejects results from stale reads
 *  and rotations after logout, account changes, or workspace switches. */
interface PairingCodesState {
  companyId: string | null
  code: string | null
  requestVersion: number
  beginRequest: (companyId: string, clearCode?: boolean) => number
  setCodeIfCurrent: (companyId: string, requestVersion: number, code: string) => void
  clear: () => void
}

export const usePairingCodes = create<PairingCodesState>((set, get) => ({
  companyId: null,
  code: null,
  requestVersion: 0,
  beginRequest: (companyId, clearCode = false) => {
    const requestVersion = get().requestVersion + 1
    set((state) => ({
      companyId,
      code: clearCode || state.companyId !== companyId ? null : state.code,
      requestVersion,
    }))
    return requestVersion
  },
  setCodeIfCurrent: (companyId, requestVersion, code) => {
    const state = get()
    if (state.companyId !== companyId || state.requestVersion !== requestVersion) return
    set({ code })
  },
  clear: () => set((state) => ({
    companyId: null,
    code: null,
    requestVersion: state.requestVersion + 1,
  })),
}))
