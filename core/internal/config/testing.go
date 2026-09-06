package config

// TestingEnvironment comes from explicit workspace fields, never model-authored notes.
type TestingEnvironment struct {
	URL         string            `json:"url"`
	Credentials map[string]string `json:"credentials"`
}
