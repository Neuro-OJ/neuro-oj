export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const target = `${config.apiBase}${event.path}`
  return proxyRequest(event, target)
})
