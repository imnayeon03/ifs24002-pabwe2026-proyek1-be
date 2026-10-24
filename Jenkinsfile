pipeline {
  agent any
  tools { nodejs 'node-22' }
  stages {
    stage('Checkout') { steps { checkout scm } }
    stage('Install') { steps { sh 'npm ci' } }
    stage('Test') { steps { sh 'npm test' } }
  }
  post {
    success { echo 'Pipeline backend berhasil: tes API lulus.' }
    failure { echo 'Pipeline gagal, cek log stage di atas.' }
  }
}
