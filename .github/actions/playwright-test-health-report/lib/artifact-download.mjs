import path from 'path';
import unzipper from 'unzipper';

export async function downloadArtifactZip(github, { owner, repo, artifactId }) {
  const response = await github.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifactId,
    archive_format: 'zip',
  });

  const buffer = Buffer.from(response.data);
  return unzipper.Open.buffer(buffer);
}

export function findFilesInZip(zip, filePattern) {
  return zip.files.filter(file => {
    const fileName = path.basename(file.path);
    return file.path.startsWith(filePattern) || fileName.startsWith(filePattern);
  });
}
