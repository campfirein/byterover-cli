import {useEffect} from 'react'
import {Navigate, Outlet, useLocation, useSearchParams} from 'react-router-dom'

import {useTransportStore} from '../../../stores/transport-store'
import {AuthInitializer} from '../../auth/components/auth-initializer'
import {TaskSubscriptionInitializer} from '../../tasks/components/task-subscription-initializer'
import {useGetProjectList} from '../api/get-project-list'
import {resolveAutoSelectProject} from '../utils/resolve-auto-select-project'
import {ProjectAssociationInitializer} from './project-association-initializer'

export function ProjectGuard() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isConnected = useTransportStore((s) => s.isConnected)
  const selectedProject = useTransportStore((s) => s.selectedProject)
  const projectCwd = useTransportStore((s) => s.projectCwd)
  const setSelectedProject = useTransportStore((s) => s.setSelectedProject)

  const {data: projResp, isLoading: isProjectListLoading} = useGetProjectList({
    queryConfig: {
      enabled: isConnected,
    },
  })

  const projects = projResp?.locations
  const urlParam = searchParams.get('project') ?? undefined
  const candidate = projects
    ? resolveAutoSelectProject({
        projectCwd: projectCwd || undefined,
        projects,
        selectedProject: selectedProject || undefined,
        urlParam,
      })
    : undefined

  useEffect(() => {
    if (!projects) return

    if (candidate && candidate !== selectedProject) {
      setSelectedProject(candidate)
    }

    if (urlParam) {
      const next = new URLSearchParams(searchParams)
      next.delete('project')
      setSearchParams(next, {replace: true})
    }
  }, [candidate, projects, selectedProject, urlParam, setSearchParams, setSelectedProject])

  if (urlParam) return null

  if (selectedProject) {
    return (
      <AuthInitializer>
        <ProjectAssociationInitializer />
        <TaskSubscriptionInitializer />
        <Outlet />
      </AuthInitializer>
    )
  }

  if (!isConnected || isProjectListLoading || !projects) {
    return null
  }

  if (candidate) return null

  return <Navigate replace state={{from: location}} to="/projects" />
}
