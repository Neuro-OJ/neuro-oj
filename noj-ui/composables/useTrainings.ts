import type { ApiCallOptions } from '~/composables/useApi';

export type TrainingVisibility = 'private' | 'unlisted' | 'public';

export interface Training {
  id: string;
  title: string;
  description: string;
  visibility: TrainingVisibility;
  is_pinned: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  problem_count: number;
}

export interface TrainingProblem {
  training_id: string;
  problem_id: string;
  position: number;
  title: string;
  description: string;
  difficulty: string;
  display_id: string;
  type: string;
  is_objective: boolean;
  accepted: boolean;
}

export interface TrainingPayload {
  title: string;
  description?: string;
  visibility?: TrainingVisibility;
}

export interface TrainingListResult {
  data: Training[];
  total: number;
}

export function useTrainings() {
  const { api } = useApi();

  function listPublic(
    query?: { page?: number; per_page?: number },
    options?: ApiCallOptions,
  ) {
    return api.get<TrainingListResult>('/api/v1/trainings', {
      query,
      silent: true,
      ...options,
    });
  }

  function listMine(
    query?: { page?: number; per_page?: number },
    options?: ApiCallOptions,
  ) {
    return api.get<TrainingListResult>('/api/v1/trainings/mine', {
      query,
      silent: true,
      ...options,
    });
  }

  function listContainingProblem(problemId: string, options?: ApiCallOptions) {
    return api.get<{ data: string[] }>('/api/v1/trainings/containing', {
      query: { problem_id: problemId },
      silent: true,
      ...options,
    });
  }

  function listUserTrainings(
    createdBy: string,
    query?: { page?: number; per_page?: number },
    options?: ApiCallOptions,
  ) {
    return api.get<TrainingListResult>(
      `/api/v1/trainings?created_by=${createdBy}`,
      {
        query,
        silent: true,
        ...options,
      },
    );
  }

  function getTraining(id: string, options?: ApiCallOptions) {
    return api.get<{ data: Training }>(`/api/v1/trainings/${id}`, {
      silent: true,
      ...options,
    });
  }

  function createTraining(body: TrainingPayload, options?: ApiCallOptions) {
    return api.post<{ data: Training }>('/api/v1/trainings', body, options);
  }

  function updateTraining(
    id: string,
    body: Partial<TrainingPayload>,
    options?: ApiCallOptions,
  ) {
    return api.put<{ data: Training }>(
      `/api/v1/trainings/${id}`,
      body,
      options,
    );
  }

  function deleteTraining(id: string, options?: ApiCallOptions) {
    return api.delete<void>(`/api/v1/trainings/${id}`, options);
  }

  function listTrainingProblems(id: string, options?: ApiCallOptions) {
    return api.get<{ data: TrainingProblem[] }>(
      `/api/v1/trainings/${id}/problems`,
      { silent: true, ...options },
    );
  }

  function addProblem(
    id: string,
    problemId: string,
    position?: number,
    options?: ApiCallOptions,
  ) {
    return api.post<{ data: TrainingProblem }>(
      `/api/v1/trainings/${id}/problems`,
      { problem_id: problemId, position },
      options,
    );
  }

  function reorderProblems(
    id: string,
    problems: { problem_id: string; position: number }[],
    options?: ApiCallOptions,
  ) {
    return api.put<{ data: TrainingProblem[] }>(
      `/api/v1/trainings/${id}/problems`,
      { problems },
      options,
    );
  }

  function removeProblem(
    id: string,
    problemId: string,
    options?: ApiCallOptions,
  ) {
    return api.delete<void>(
      `/api/v1/trainings/${id}/problems/${problemId}`,
      options,
    );
  }

  function adminListTrainings(
    query?: { page?: number; per_page?: number },
    options?: ApiCallOptions,
  ) {
    return api.get<TrainingListResult>('/api/v1/admin/trainings', {
      query,
      silent: true,
      ...options,
    });
  }

  function adminUpdateTraining(
    id: string,
    body: Partial<TrainingPayload & { is_pinned?: boolean }>,
    options?: ApiCallOptions,
  ) {
    return api.patch<{ data: Training }>(
      `/api/v1/admin/trainings/${id}`,
      body,
      options,
    );
  }

  function adminDeleteTraining(id: string, options?: ApiCallOptions) {
    return api.delete<void>(`/api/v1/admin/trainings/${id}`, options);
  }

  return {
    listPublic,
    listMine,
    listContainingProblem,
    listUserTrainings,
    getTraining,
    createTraining,
    updateTraining,
    deleteTraining,
    listTrainingProblems,
    addProblem,
    reorderProblems,
    removeProblem,
    adminListTrainings,
    adminUpdateTraining,
    adminDeleteTraining,
  };
}
