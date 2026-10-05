import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dashboard, PartSummary } from '../domain/stock';
import { api } from './api';

export interface Option { id: number; name: string }
export interface Location { id: number; code: string; name: string; lotCount: number; units: number }
export interface Donor {
  id: number; code: string; device: string; receivedAt: string | null; condition: string;
  status: 'stripping' | 'done' | 'parked'; notes: string; partLines: number; unitsHarvested: number; estValueIdr: number;
}

export function useParts() {
  return useQuery({
    queryKey: ['parts'],
    staleTime: 30_000,
    queryFn: async () => {
      const all: PartSummary[] = [];
      let after = 0;
      for (;;) {
        const page = await api<{ parts: PartSummary[]; next: number | null }>(`/parts?after=${after}&limit=500`);
        all.push(...page.parts);
        if (page.next === null) return all;
        after = page.next;
      }
    },
  });
}
export const useDashboard = () => useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard') });
export const useUsage = () =>
  useQuery({ queryKey: ['usage'], queryFn: () => api<{ rowsRead: number; rowsWritten: number; requests: number; limits: { rowsRead: number; rowsWritten: number; requests: number } }>('/usage') });
export const useCategories = () => useQuery({ queryKey: ['categories'], staleTime: Infinity, queryFn: async () => (await api<{ categories: Option[] }>('/categories')).categories });
export const useLocations = () => useQuery({ queryKey: ['locations'], queryFn: async () => (await api<{ locations: Location[] }>('/locations')).locations });
export const useDonors = () => useQuery({ queryKey: ['donors'], queryFn: async () => (await api<{ donors: Donor[] }>('/donors')).donors });

/** Stock changed: everything derived from lots is stale. */
export function useRefreshStock() {
  const qc = useQueryClient();
  return () => Promise.all(['parts', 'part', 'dashboard', 'locations', 'donors', 'usage', 'buylist'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

import type { BuyList } from '../domain/purchasing';
export interface SupplierRow {
  id: number; name: string; kind: string; orderShippingIdr: number; freeShipOverIdr: number | null; leadDays: number | null; url: string | null; notes: string | null;
}
export interface ProjectRow { id: number; name: string; status: string; kicadProject: string | null; notes: string; needCount: number; toBuyCount: number }
export const useBuyList = () => useQuery({ queryKey: ['buylist'], queryFn: () => api<{ buyList: BuyList; suppliers: SupplierRow[] }>('/buylist') });
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: async () => (await api<{ projects: ProjectRow[] }>('/projects')).projects });
export const useSuppliers = () => useQuery({ queryKey: ['suppliers'], queryFn: async () => (await api<{ suppliers: SupplierRow[] }>('/suppliers')).suppliers });

/** Anything that changes needs, quotes or stock changes what to buy. */
export function useRefreshBuying() {
  const qc = useQueryClient();
  return () => Promise.all(['buylist', 'projects', 'quotes', 'suppliers', 'parts', 'part', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}
